// Run with `node --test src/limits/limits.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import { limitsShelf, paceShare, warns } from "./limits.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60_000;
/** No weekend: the pace by the calendar. */
const NONE: ReadonlySet<number> = new Set();
/** Saturday and Sunday, the setting's default. */
const SAT_SUN: ReadonlySet<number> = new Set([6, 0]);

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
    NodeAssert.equal(warns(window("w", 96, 0.99), NOW, NONE), true);
    NodeAssert.equal(warns(window("w", 95, 0.99), NOW, NONE), false);
  });

  NodeTest.test("on a pace that runs out before the reset, past upstream's five points", () => {
    NodeAssert.equal(warns(window("w", 56, 0.5), NOW, NONE), true);
    NodeAssert.equal(warns(window("w", 55, 0.5), NOW, NONE), false);
  });

  NodeTest.test("without a reset clock, on the 95% rule alone", () => {
    NodeAssert.equal(warns(window("w", 90, null), NOW, NONE), false);
    NodeAssert.equal(warns(window("w", 99, null), NOW, NONE), true);
  });
});

NodeTest.describe("paceShare", () => {
  // In the page's time zone, as the weekend is: Monday 9 November 2026 to the Monday after, no DST change between.
  const at = (day: number, hour = 0) => new Date(2026, 10, day, hour).getTime();
  const between = (start: number, end: number): ServerProviderUsageWindow => ({
    id: "w",
    kind: "weekly",
    label: "w",
    usedPercent: 50,
    resetsAt: new Date(end).toISOString(),
    windowDurationMins: (end - start) / 60_000,
  });
  const week = between(at(9), at(16));

  NodeTest.test("counts only the working days of a window of a day or longer", () => {
    NodeAssert.equal(paceShare(week, at(11, 12), SAT_SUN), 0.5);
    NodeAssert.equal(paceShare(week, at(14), SAT_SUN), 1);
    NodeAssert.equal(paceShare(week, at(15, 12), SAT_SUN), 1);
  });

  NodeTest.test("by the calendar with no weekend", () => {
    NodeAssert.equal(paceShare(week, at(14), NONE), 5 / 7);
  });

  NodeTest.test("by the calendar for a window shorter than a day", () => {
    const session = between(at(14, 10), at(14, 15));
    NodeAssert.equal(paceShare(session, at(14, 12), SAT_SUN), 0.4);
  });

  NodeTest.test("by the calendar for a window with no working time", () => {
    const saturday = between(at(14), at(15));
    NodeAssert.equal(paceShare(saturday, at(14, 12), SAT_SUN), 0.5);
  });

  NodeTest.test("warns on the weekend-aware pace", () => {
    // Friday noon, 4.5 of 5 working days gone: 80% used is on pace, though 4.5 of 7 calendar days are not.
    const spent = { ...week, usedPercent: 80 };
    NodeAssert.equal(warns(spent, at(13, 12), SAT_SUN), false);
    NodeAssert.equal(warns(spent, at(13, 12), NONE), true);
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
      NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, false, NONE)), {
        accounts: [["claude", ["session!"]]],
        warnings: 1,
        toggle: "all",
      });
    },
  );

  NodeTest.test("Show all shows every window with something spent, with Show less", () => {
    NodeAssert.deepEqual(shape(limitsShelf(accounts, NOW, true, NONE)), {
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
    NodeAssert.equal(limitsShelf(warning, NOW, false, NONE)?.toggle, null);
    NodeAssert.equal(limitsShelf(warning, NOW, true, NONE)?.toggle, null);
  });

  NodeTest.test(
    "while none warns, shows every window with something spent, and no zero window or account",
    () => {
      const quiet = [accounts[1]!, accounts[2]!, account("claude", window("weekly", 20, 0.5))];
      for (const showAll of [false, true]) {
        NodeAssert.deepEqual(shape(limitsShelf(quiet, NOW, showAll, NONE)), {
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
    NodeAssert.equal(limitsShelf([accounts[2]!], NOW, false, NONE), null);
    NodeAssert.equal(limitsShelf([accounts[2]!], NOW, true, NONE), null);
  });
});
