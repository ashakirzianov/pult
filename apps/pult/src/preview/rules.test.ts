// Run with `node --test src/preview/rules.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  closingEndsSession,
  foreignPreviews,
  JUST_OPENED_MS,
  liveReveals,
  placementGroup,
  placementIndex,
  previewAnchor,
  staleTabs,
} from "./rules.ts";

NodeTest.test(
  "a selected Star's channel open as a tab opens its browsers beside that tab, and no other thread does",
  () => {
    const user = { environmentId: "env", threadId: "user-now" };
    const work = { environmentId: "env", threadId: "work-now", group: "right" };
    const channels = [work, { environmentId: "env", threadId: "review-now", group: "left" }];
    NodeAssert.equal(previewAnchor(user, user, channels), "lead");
    NodeAssert.equal(
      previewAnchor({ environmentId: "env", threadId: "work-now" }, user, channels),
      work,
    );
    // `user` asleep, the Star's tab on its draft: a channel's tab still opens its own.
    NodeAssert.equal(
      previewAnchor({ environmentId: "env", threadId: "work-now" }, undefined, channels),
      work,
    );
    NodeAssert.equal(
      previewAnchor({ environmentId: "other", threadId: "work-now" }, user, channels),
      undefined,
    );
    NodeAssert.equal(
      previewAnchor({ environmentId: "env", threadId: "child" }, user, channels),
      undefined,
    );
  },
);

NodeTest.test(
  "a selected Star's child open as a tab opens its browsers beside that tab, as a channel's does",
  () => {
    const user = { environmentId: "env", threadId: "user-now" };
    const child = { environmentId: "env", threadId: "child", group: "left" };
    const tabs = [{ environmentId: "env", threadId: "work-now", group: "right" }, child];
    NodeAssert.equal(previewAnchor({ environmentId: "env", threadId: "child" }, user, tabs), child);
    NodeAssert.equal(
      previewAnchor({ environmentId: "env", threadId: "child" }, undefined, tabs),
      child,
    );
    // Its tab closed: its browsers have no place.
    NodeAssert.equal(
      previewAnchor({ environmentId: "env", threadId: "child" }, user, tabs.slice(0, 1)),
      undefined,
    );
  },
);

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

NodeTest.test(
  "a new browser opens after the thread's last one, else right after the Star's tab it belongs beside",
  () => {
    NodeAssert.equal(placementIndex([3, 5, 4], 1), 6);
    // A child's tab at 2, the Star's tab at 0 and active: right after the child's, not after the active one.
    NodeAssert.equal(placementIndex([], 2), 3);
    NodeAssert.equal(placementIndex([], undefined), undefined);
  },
);

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

NodeTest.test("a tab whose session's close is in flight is not stale, with no recheck", () => {
  const result = staleTabs({
    open: ["ending", "gone"],
    live: [],
    openedAt: () => undefined,
    closing: (tabId) => tabId === "ending",
    now: 100_000,
  });
  NodeAssert.deepEqual(result, { close: ["gone"], recheckAt: undefined });
});

NodeTest.test("remembered reveals keep only the sessions still live", () => {
  NodeAssert.deepEqual(liveReveals(new Set(["a", "b"]), ["b", "c"]), new Set(["b"]));
  NodeAssert.deepEqual(liveReveals(new Set(["a"]), []), new Set());
});

NodeTest.test("a list not loaded yet closes nothing", () => {
  const result = staleTabs({
    open: ["restored"],
    live: [],
    openedAt: () => undefined,
    loaded: false,
    now: 100_000,
  });
  NodeAssert.deepEqual(result, { close: [], recheckAt: undefined });
});

NodeTest.test(
  "a Star's thread's tab closed while `user` sleeps takes its browsers, and leaves `user`'s as they are",
  () => {
    const browser = (threadId: string, tabId: string) => ({
      environmentId: "env",
      threadId,
      tabId,
    });
    const previews = [browser("child", "a"), browser("work-now", "b"), browser("user-old", "c")];
    const anchored = (thread: { readonly threadId: string }) => thread.threadId === "work-now";
    const closed = { environmentId: "env", threadId: "child" };
    // `user` asleep: the set is not known, so only the closed tab's thread's browsers go.
    NodeAssert.deepEqual(foreignPreviews(previews, anchored, { known: false, closed }), [
      browser("child", "a"),
    ]);
    NodeAssert.deepEqual(foreignPreviews(previews, anchored, { known: false }), []);
    // A tab moved to another group is still there: its browsers stay.
    NodeAssert.deepEqual(
      foreignPreviews(previews, (thread) => thread.threadId !== "user-old", {
        known: false,
        closed,
      }),
      [],
    );
    NodeAssert.deepEqual(foreignPreviews(previews, anchored, { known: true, closed }), [
      browser("child", "a"),
      browser("user-old", "c"),
    ]);
  },
);
