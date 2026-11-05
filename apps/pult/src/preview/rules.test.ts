// Run with `node --test src/preview/rules.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { closingEndsSession, JUST_OPENED_MS, placementGroup, staleTabs } from "./rules.ts";

NodeTest.test(
  "closing an agent's tab keeps its session; a user's or unclaimed one's ends it",
  () => {
    NodeAssert.equal(closingEndsSession("agent"), false);
    NodeAssert.equal(closingEndsSession("human"), true);
    NodeAssert.equal(closingEndsSession("unclaimed"), true);
    NodeAssert.equal(closingEndsSession(undefined), false);
  },
);

NodeTest.test("a new tab goes to the group of the thread's latest preview tab", () => {
  const previews = [
    { group: "left", seen: 3 },
    { group: "right", seen: 5 },
    { group: "left", seen: 4 },
  ];
  NodeAssert.equal(placementGroup(previews, "left", "active"), "right");
});

NodeTest.test("with no preview tab, the thread tab's group, else the active one", () => {
  NodeAssert.equal(placementGroup([], "lead", "active"), "lead");
  NodeAssert.equal(placementGroup([], undefined, "active"), "active");
});

NodeTest.test("tabs whose session is gone are stale", () => {
  const result = staleTabs({
    open: ["a", "b", "c"],
    live: ["b"],
    openedAt: () => undefined,
    now: 100_000,
  });
  NodeAssert.deepEqual(result, { close: ["a", "c"], recheckAt: undefined });
});

NodeTest.test("a tab the page just opened waits out a list that lacks it, then closes", () => {
  const openedAt = (tabId: string) => (tabId === "new" ? 50_000 : undefined);
  const early = staleTabs({ open: ["new", "old"], live: [], openedAt, now: 51_000 });
  NodeAssert.deepEqual(early, { close: ["old"], recheckAt: 50_000 + JUST_OPENED_MS });
  const late = staleTabs({ open: ["new"], live: [], openedAt, now: 50_000 + JUST_OPENED_MS });
  NodeAssert.deepEqual(late, { close: ["new"], recheckAt: undefined });
});

NodeTest.test("a just-opened tab whose session is live is kept with no recheck", () => {
  const result = staleTabs({ open: ["new"], live: ["new"], openedAt: () => 0, now: 1 });
  NodeAssert.deepEqual(result, { close: [], recheckAt: undefined });
});
