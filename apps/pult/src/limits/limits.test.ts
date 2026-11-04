// Run with `node --test src/limits/limits.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import { limitsShelf, warns } from "./limits.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60_000;

/** A window `elapsed` of the way through its `hours`, with `usedPercent` spent; no reset clock with `elapsed` null. */
function window(
  id: string,
  usedPercent: number,
  elapsed: number | null = 0.5,
  hours = 100,
): ServerProviderUsageWindow {
  return {
    id,
    kind: "weekly",
    label: id,
    usedPercent,
    ...(elapsed === null
      ? {}
      : {
          resetsAt: new Date(NOW + (1 - elapsed) * hours * HOUR).toISOString(),
          windowDurationMins: hours * 60,
        }),
  };
}

const account = (key: string, ...windows: ServerProviderUsageWindow[]) => ({
  key,
  limits: { windows },
});

const shape = (shelf: ReturnType<typeof limitsShelf<ReturnType<typeof account>>>) =>
  shelf && {
    accounts: shelf.accounts.map(({ account, windows }) => [
      account.key,
      windows.map(({ window, warning }) => `${window.id}${warning ? "!" : ""}`),
    ]),
    warnings: shelf.warnings,
    toggle: shelf.toggle,
  };

NodeTest.describe("warns", () => {
  NodeTest.test("past 95% used, whatever the pace", () => {
    NodeAssert.equal(warns(window("w", 96, 0.99), NOW), true);
    NodeAssert.equal(warns(window("w", 95, 0.99), NOW), false);
  });

  NodeTest.test("on a pace that runs out before the reset, past upstream's five points", () => {
    NodeAssert.equal(warns(window("w", 56, 0.5), NOW), true);
    NodeAssert.equal(warns(window("w", 55, 0.5), NOW), false);
  });

  NodeTest.test("without a reset clock, on the 95% rule alone", () => {
    NodeAssert.equal(warns(window("w", 90, null), NOW), false);
    NodeAssert.equal(warns(window("w", 99, null), NOW), true);
  });
});

NodeTest.describe("limitsShelf", () => {
  const accounts = [
    account("claude", window("session", 80, 0.5), window("weekly", 20, 0.5)),
    account("codex", window("session", 0), window("weekly", 10, 0.5)),
    account("idle", window("session", 0)),
  ];

  NodeTest.test(
    "warn shows the warning windows alone, with Show all while others would show",
    () => {
      NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, "warn", false)), {
        accounts: [["claude", ["session!"]]],
        warnings: 1,
        toggle: "all",
      });
    },
  );

  NodeTest.test("warn with nothing warning is no shelf at all", () => {
    NodeAssert.equal(limitsShelf([accounts[1]!, accounts[2]!], NOW, "warn", false), null);
  });

  NodeTest.test("warn with every shown window warning offers no Show all", () => {
    NodeAssert.equal(
      limitsShelf(
        [account("claude", window("session", 99), window("weekly", 0))],
        NOW,
        "warn",
        false,
      )?.toggle,
      null,
    );
  });

  NodeTest.test(
    "always shows every window with something spent, and no zero window or account",
    () => {
      NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, "always", false)), {
        accounts: [
          ["claude", ["session!", "weekly"]],
          ["codex", ["weekly"]],
        ],
        warnings: 1,
        toggle: null,
      });
    },
  );

  NodeTest.test("always with nothing spent is no shelf", () => {
    NodeAssert.equal(limitsShelf([accounts[2]!], NOW, "always", false), null);
  });

  NodeTest.test("hidden is no shelf, unless everything is asked for", () => {
    NodeAssert.equal(limitsShelf(accounts, NOW, "hidden", false), null);
    NodeAssert.equal(shape(limitsShelf(accounts, NOW, "hidden", true))?.toggle, "less");
  });

  NodeTest.test(
    "Show all shows everything in warn, with Show less, even with nothing warning",
    () => {
      NodeAssert.deepEqual(shape(limitsShelf([accounts[1]!], NOW, "warn", true)), {
        accounts: [["codex", ["weekly"]]],
        warnings: 0,
        toggle: "less",
      });
    },
  );
});
