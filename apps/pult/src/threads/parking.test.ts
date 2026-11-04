// Run with `node --test src/threads/parking.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { nextAfterParking, parkActions, parseCustomSnooze } from "./parking.ts";
import type { ShelfName } from "./store.ts";

const list = (...threads: Array<[string, ShelfName | null]>) =>
  threads.map(([id, shelf]) => ({ id, shelf }));

NodeTest.test("the next card after the parked one is selected", () => {
  const threads = list(["a", "pinned"], ["b", "active"], ["c", "active"]);
  NodeAssert.equal(nextAfterParking(threads, "b", new Set()), "c");
});

NodeTest.test("the search wraps to the top", () => {
  const threads = list(["a", "pinned"], ["b", "active"], ["c", "active"]);
  NodeAssert.equal(nextAfterParking(threads, "c", new Set()), "a");
});

NodeTest.test("threads being parked, snoozed, settled and subagents are skipped", () => {
  const threads = list(
    ["a", "active"],
    ["b", "active"],
    ["c", "active"],
    ["d", "snoozed"],
    ["e", "settled"],
    ["f", null],
  );
  NodeAssert.equal(nextAfterParking(threads, "a", new Set(["b"])), "c");
  NodeAssert.equal(nextAfterParking(threads, "a", new Set(["b", "c"])), null);
});

NodeTest.test("a snoozed thread searches on after it, an unlisted one from the top", () => {
  const threads = list(["a", "active"], ["d", "snoozed"], ["b", "active"]);
  NodeAssert.equal(nextAfterParking(threads, "d", new Set()), "b");
  NodeAssert.equal(nextAfterParking(threads, "missing", new Set()), "a");
});

NodeTest.test("the only card leaves nothing to select", () => {
  NodeAssert.equal(nextAfterParking(list(["a", "active"]), "a", new Set()), null);
});

NodeTest.test("actions follow the shelf and the server's features", () => {
  const all = { settlement: true, snooze: true, pinning: true };
  NodeAssert.deepEqual(parkActions({ shelf: "active", pinned: false }, all), {
    settle: true,
    unsettle: false,
    snooze: true,
    wake: false,
    pin: true,
    unpin: false,
  });
  NodeAssert.deepEqual(parkActions({ shelf: "snoozed", pinned: true }, all), {
    settle: true,
    unsettle: false,
    snooze: false,
    wake: true,
    pin: false,
    unpin: true,
  });
  NodeAssert.deepEqual(
    parkActions({ shelf: "settled", pinned: false }, { ...all, settlement: false }),
    {
      settle: false,
      unsettle: false,
      snooze: true,
      wake: false,
      pin: true,
      unpin: false,
    },
  );
  NodeAssert.ok(
    Object.values(parkActions({ shelf: null, pinned: false }, all)).every((offered) => !offered),
  );
});

NodeTest.test("a custom snooze is a duration or a local time, in the future", () => {
  const now = new Date(2026, 9, 20, 9, 0);
  NodeAssert.equal(parseCustomSnooze("45m", now), new Date(2026, 9, 20, 9, 45).toISOString());
  NodeAssert.equal(parseCustomSnooze(" 2H ", now), new Date(2026, 9, 20, 11, 0).toISOString());
  NodeAssert.equal(
    parseCustomSnooze("2026-10-21 08:30", now),
    new Date(2026, 9, 21, 8, 30).toISOString(),
  );
  NodeAssert.equal(parseCustomSnooze("2026-10-19 08:30", now), null);
  NodeAssert.equal(parseCustomSnooze("2026-02-30 08:30", now), null);
  NodeAssert.equal(parseCustomSnooze("0m", now), null);
  NodeAssert.equal(parseCustomSnooze("soon", now), null);
});
