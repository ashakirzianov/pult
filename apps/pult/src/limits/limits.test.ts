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
    "while any window warns, shows the warning windows alone, with Show all while others would show",
    () => {
      NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, false)), {
        accounts: [["claude", ["session!"]]],
        warnings: 1,
        toggle: "all",
      });
    },
  );

  NodeTest.test("Show all shows every window with something spent, with Show less", () => {
    NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, true)), {
      accounts: [
        ["claude", ["session!", "weekly"]],
        ["codex", ["weekly"]],
      ],
      warnings: 1,
      toggle: "less",
    });
  });

  NodeTest.test("with every shown window warning offers no Show all", () => {
    const warning = [account("claude", window("session", 99), window("weekly", 0))];
    NodeAssert.equal(limitsShelf(warning, NOW, false)?.toggle, null);
    NodeAssert.equal(limitsShelf(warning, NOW, true)?.toggle, null);
  });

  NodeTest.test(
    "while none warns, shows every window with something spent, and no zero window or account",
    () => {
      const quiet = [accounts[1]!, accounts[2]!, account("claude", window("weekly", 20, 0.5))];
      for (const showAll of [false, true]) {
        NodeAssert.deepEqual(shape(limitsShelf(quiet, NOW, showAll)), {
          accounts: [
            ["codex", ["weekly"]],
            ["claude", ["weekly"]],
          ],
          warnings: 0,
          toggle: null,
        });
      }
    },
  );

  NodeTest.test("with nothing spent is no shelf, whatever is asked for", () => {
    NodeAssert.equal(limitsShelf([accounts[2]!], NOW, false), null);
    NodeAssert.equal(limitsShelf([accounts[2]!], NOW, true), null);
  });
});
