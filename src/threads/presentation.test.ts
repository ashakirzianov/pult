// Run with `node --test src/threads/presentation.test.ts`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, type OrchestrationV2ThreadShell, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { v2ThreadShell } from "../../vendor/t3code/packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { nextWake, NO_THREAD_FEATURES, shellThreads, shelve, threadStatus } from "./presentation.ts";

const NOW = "2026-06-20T12:00:00.000Z";
const ALL = { settlement: true, snooze: true, pinning: true };
const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return presentThreadShell(EnvironmentId.make("env"), { ...v2ThreadShell, id: ThreadId.make(id), ...overrides });
}

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((each) => each.id);

const subagentOf = (root: string) => ({
  lineage: {
    rootThreadId: ThreadId.make(root),
    parentThreadId: ThreadId.make(root),
    relationshipToParent: "subagent" as const,
  },
});

describe("shelve", () => {
  test("puts a thread on one shelf: snoozed, then settled, then pinned, then active", () => {
    const shelves = shelve(
      [
        thread("snoozed-settled-pinned", {
          snoozedUntil: at("2026-06-20T15:00:00.000Z"),
          settledOverride: "settled",
          pinnedAt: at("2026-06-19T00:00:00.000Z"),
        }),
        thread("settled-pinned", { settledOverride: "settled", pinnedAt: at("2026-06-19T00:00:00.000Z") }),
        thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
        thread("woken", { snoozedUntil: at("2026-06-20T11:00:00.000Z") }),
      ],
      NOW,
      ALL,
    );
    assert.deepEqual(ids(shelves.snoozed), ["snoozed-settled-pinned"]);
    assert.deepEqual(ids(shelves.settled), ["settled-pinned"]);
    assert.deepEqual(ids(shelves.pinned), ["pinned"]);
    assert.deepEqual(ids(shelves.active), ["woken"]);
  });

  test("keeps every thread off the shelves a server does not advertise", () => {
    const shelves = shelve(
      [thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }), thread("settled", { settledOverride: "settled" })],
      NOW,
      NO_THREAD_FEATURES,
    );
    assert.deepEqual(ids(shelves.active).toSorted(), ["settled", "snoozed"]);
    assert.deepEqual([...shelves.snoozed, ...shelves.settled], []);
  });

  test("leaves out archived, deleted and subagent threads", () => {
    const shelves = shelve(
      [thread("archived", { archivedAt: at(NOW) }), thread("deleted", { deletedAt: at(NOW) }), thread("subagent", subagentOf("root"))],
      NOW,
      ALL,
    );
    assert.deepEqual([shelves.pinned, shelves.active, shelves.snoozed, shelves.settled].flat(), []);
  });

  test("orders pins by their arranged keys and snoozes by the soonest wake", () => {
    const pinnedAt = at("2026-06-19T00:00:00.000Z");
    const shelves = shelve(
      [
        thread("pin-b", { pinnedAt, pinOrderKey: "b" }),
        thread("pin-a", { pinnedAt, pinOrderKey: "a" }),
        thread("wakes-later", { snoozedUntil: at("2026-06-21T09:00:00.000Z") }),
        thread("wakes-sooner", { snoozedUntil: at("2026-06-20T13:00:00.000Z") }),
      ],
      NOW,
      ALL,
    );
    assert.deepEqual(ids(shelves.pinned), ["pin-a", "pin-b"]);
    assert.deepEqual(ids(shelves.snoozed), ["wakes-sooner", "wakes-later"]);
    assert.equal(nextWake(shelves.snoozed, Date.parse(NOW)), Date.parse("2026-06-20T13:00:00.000Z"));
  });
});

describe("threadStatus", () => {
  const request = (kind: "command" | "user_input") => ({ id: RuntimeRequestId.make("request"), kind, createdAt: at(NOW) });
  const running = (status: OrchestrationV2ThreadShell["status"]) => ({
    latestRunId: RunId.make("run"),
    activeRunId: RunId.make("run"),
    status,
  });
  const completed = {
    latestRunId: RunId.make("run"),
    status: "completed" as const,
    latestRunCompletedAt: at("2026-06-20T11:00:00.000Z"),
  };
  const status = (overrides: Partial<OrchestrationV2ThreadShell>) => threadStatus(thread("t", overrides), NOW);

  test("badges what waits on the user W, ahead of a running agent", () => {
    assert.deepEqual(status({ ...running("running"), pendingRuntimeRequest: request("command") }), { label: "Approval", badge: "W" });
    assert.deepEqual(status({ pendingRuntimeRequest: request("user_input") }), { label: "Input", badge: "W" });
  });

  test("badges an agent at work R, queued or running, and a failed one F", () => {
    assert.deepEqual(status(running("running")), { label: "Working", badge: "R" });
    assert.deepEqual(status(running("queued")), { label: "Working", badge: "R" });
    assert.deepEqual(status(running("failed")), { label: "Failed", badge: "F" });
    assert.deepEqual(status({ ...running("failed"), lastErrorClass: "usage_limit" }), { label: "Limited", badge: "F" });
  });

  test("shows Plan Ready only once the plan's run has settled", () => {
    const plan = { interactionMode: "plan" as const, hasActionableProposedPlan: true };
    assert.deepEqual(status({ ...plan, ...completed, lastVisitedAt: at(NOW) }), { label: "Plan Ready", badge: "W" });
    assert.equal(status({ ...plan, ...running("running") })?.label, "Working");
    // Completed, but still the runtime's active run: not settled yet.
    assert.equal(status({ ...plan, ...completed, activeRunId: RunId.make("run"), lastVisitedAt: at(NOW) }), null);
  });

  test("shows a snooze that ended Woke until the thread is visited or settled", () => {
    const woken = { snoozedAt: at("2026-06-20T09:00:00.000Z"), snoozedUntil: at("2026-06-20T11:30:00.000Z") };
    assert.deepEqual(status({ ...woken, lastVisitedAt: at("2026-06-20T10:00:00.000Z") }), { label: "Woke", badge: "W" });
    assert.equal(status({ ...woken, lastVisitedAt: at("2026-06-20T11:45:00.000Z") }), null);
    assert.equal(status({ ...woken, settledOverride: "settled" }), null);
    assert.equal(status({ ...woken, snoozedUntil: at("2026-06-20T13:00:00.000Z") }), null);
  });

  test("labels an unseen completion Done without a badge, and a seen one not at all", () => {
    assert.deepEqual(status({ ...completed, lastVisitedAt: at("2026-06-20T10:00:00.000Z") }), { label: "Done", badge: null });
    assert.equal(status({ ...completed, lastVisitedAt: at("2026-06-20T11:30:00.000Z") }), null);
  });
});

describe("shellThreads", () => {
  test("lists the shelves in order, then the subagents on none, and drops archived threads", () => {
    const threads = shellThreads(
      [
        thread("subagent", subagentOf("active")),
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: at(NOW) }),
        thread("active"),
        thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }),
        thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
      ],
      [],
      NOW,
      ALL,
    );
    assert.deepEqual(
      threads.map((each) => [each.id, each.shelf]),
      [
        ["pinned", "pinned"],
        ["active", "active"],
        ["snoozed", "snoozed"],
        ["settled", "settled"],
        ["subagent", null],
      ],
    );
    const subagent = threads.at(-1);
    assert.equal(subagent?.parentId, "active");
    assert.equal(subagent?.rootId, "active");
  });

  test("counts upstream's Waiting as in motion", () => {
    const [waiting] = shellThreads([thread("t", { latestRunId: RunId.make("run"), status: "idle" })], [], NOW, ALL);
    assert.equal(waiting?.waiting, true);
    assert.equal(waiting?.working, true);
  });
});
