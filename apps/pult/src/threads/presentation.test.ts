// Run with `node --test src/threads/presentation.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  v2Project,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  nextWake,
  NO_THREAD_FEATURES,
  shellThreads,
  shelve,
  threadStatus,
} from "./presentation.ts";

const NOW = "2026-06-20T12:00:00.000Z";
const ALL = { settlement: true, snooze: true, pinning: true };
const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  environmentId = "env",
) {
  return presentThreadShell(EnvironmentId.make(environmentId), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    ...overrides,
  });
}

const ids = (threads: ReadonlyArray<{ readonly id: string }>) => threads.map((each) => each.id);

const subagentOf = (root: string) => ({
  lineage: {
    rootThreadId: ThreadId.make(root),
    parentThreadId: ThreadId.make(root),
    relationshipToParent: "subagent" as const,
  },
});

NodeTest.describe("shelve", () => {
  NodeTest.test(
    "puts a thread on one shelf: snoozed, then settled, then pinned, then active",
    () => {
      const shelves = shelve(
        [
          thread("snoozed-settled-pinned", {
            snoozedUntil: at("2026-06-20T15:00:00.000Z"),
            settledOverride: "settled",
            pinnedAt: at("2026-06-19T00:00:00.000Z"),
          }),
          thread("settled-pinned", {
            settledOverride: "settled",
            pinnedAt: at("2026-06-19T00:00:00.000Z"),
          }),
          thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
          thread("woken", { snoozedUntil: at("2026-06-20T11:00:00.000Z") }),
        ],
        NOW,
        () => ALL,
      );
      NodeAssert.deepEqual(ids(shelves.snoozed), ["snoozed-settled-pinned"]);
      NodeAssert.deepEqual(ids(shelves.settled), ["settled-pinned"]);
      NodeAssert.deepEqual(ids(shelves.pinned), ["pinned"]);
      NodeAssert.deepEqual(ids(shelves.active), ["woken"]);
    },
  );

  NodeTest.test("keeps every thread off the shelves a server does not advertise", () => {
    const shelves = shelve(
      [
        thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }),
        thread("settled", { settledOverride: "settled" }),
      ],
      NOW,
      () => NO_THREAD_FEATURES,
    );
    NodeAssert.deepEqual(ids(shelves.active).toSorted(), ["settled", "snoozed"]);
    NodeAssert.deepEqual([...shelves.snoozed, ...shelves.settled], []);
  });

  NodeTest.test("leaves out archived, deleted and subagent threads", () => {
    const shelves = shelve(
      [
        thread("archived", { archivedAt: at(NOW) }),
        thread("deleted", { deletedAt: at(NOW) }),
        thread("subagent", subagentOf("root")),
      ],
      NOW,
      () => ALL,
    );
    NodeAssert.deepEqual(
      [shelves.pinned, shelves.active, shelves.snoozed, shelves.settled].flat(),
      [],
    );
  });

  NodeTest.test("orders pins by their arranged keys and snoozes by the soonest wake", () => {
    const pinnedAt = at("2026-06-19T00:00:00.000Z");
    const shelves = shelve(
      [
        thread("pin-b", { pinnedAt, pinOrderKey: "b" }),
        thread("pin-a", { pinnedAt, pinOrderKey: "a" }),
        thread("wakes-later", { snoozedUntil: at("2026-06-21T09:00:00.000Z") }),
        thread("wakes-sooner", { snoozedUntil: at("2026-06-20T13:00:00.000Z") }),
      ],
      NOW,
      () => ALL,
    );
    NodeAssert.deepEqual(ids(shelves.pinned), ["pin-a", "pin-b"]);
    NodeAssert.deepEqual(ids(shelves.snoozed), ["wakes-sooner", "wakes-later"]);
    NodeAssert.equal(
      nextWake(shelves.snoozed, Date.parse(NOW)),
      Date.parse("2026-06-20T13:00:00.000Z"),
    );
  });
});

NodeTest.describe("threadStatus", () => {
  const request = (kind: "command" | "user_input") => ({
    id: RuntimeRequestId.make("request"),
    kind,
    createdAt: at(NOW),
  });
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
  const status = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    threadStatus(thread("t", overrides), NOW);

  NodeTest.test("badges what waits on the user W, ahead of a running agent", () => {
    NodeAssert.deepEqual(
      status({ ...running("running"), pendingRuntimeRequest: request("command") }),
      {
        label: "Approval",
        badge: "W",
      },
    );
    NodeAssert.deepEqual(status({ pendingRuntimeRequest: request("user_input") }), {
      label: "Input",
      badge: "W",
    });
  });

  NodeTest.test("badges an agent at work R, queued or running, and a failed one F", () => {
    NodeAssert.deepEqual(status(running("running")), { label: "Working", badge: "R" });
    NodeAssert.deepEqual(status(running("queued")), { label: "Working", badge: "R" });
    NodeAssert.deepEqual(status(running("failed")), { label: "Failed", badge: "F" });
    NodeAssert.deepEqual(status({ ...running("failed"), lastErrorClass: "usage_limit" }), {
      label: "Limited",
      badge: "F",
    });
  });

  NodeTest.test("shows Plan Ready only once the plan's run has settled", () => {
    const plan = { interactionMode: "plan" as const, hasActionableProposedPlan: true };
    NodeAssert.deepEqual(status({ ...plan, ...completed, lastVisitedAt: at(NOW) }), {
      label: "Plan Ready",
      badge: "W",
    });
    NodeAssert.equal(status({ ...plan, ...running("running") })?.label, "Working");
    // Completed, but still the runtime's active run: not settled yet.
    NodeAssert.equal(
      status({ ...plan, ...completed, activeRunId: RunId.make("run"), lastVisitedAt: at(NOW) }),
      null,
    );
  });

  NodeTest.test("shows a snooze that ended Woke until the thread is visited or settled", () => {
    const woken = {
      snoozedAt: at("2026-06-20T09:00:00.000Z"),
      snoozedUntil: at("2026-06-20T11:30:00.000Z"),
    };
    NodeAssert.deepEqual(status({ ...woken, lastVisitedAt: at("2026-06-20T10:00:00.000Z") }), {
      label: "Woke",
      badge: "W",
    });
    NodeAssert.equal(status({ ...woken, lastVisitedAt: at("2026-06-20T11:45:00.000Z") }), null);
    NodeAssert.equal(status({ ...woken, settledOverride: "settled" }), null);
    NodeAssert.equal(status({ ...woken, snoozedUntil: at("2026-06-20T13:00:00.000Z") }), null);
  });

  NodeTest.test(
    "labels an unseen completion Done without a badge, and a seen one not at all",
    () => {
      NodeAssert.deepEqual(
        status({ ...completed, lastVisitedAt: at("2026-06-20T10:00:00.000Z") }),
        {
          label: "Done",
          badge: null,
        },
      );
      NodeAssert.equal(
        status({ ...completed, lastVisitedAt: at("2026-06-20T11:30:00.000Z") }),
        null,
      );
    },
  );
});

NodeTest.describe("shellThreads", () => {
  NodeTest.test(
    "lists the shelves in order, then the subagents on none, and drops archived threads",
    () => {
      const threads = shellThreads(
        [
          {
            environmentId: "env",
            threads: [
              thread("subagent", subagentOf("active")),
              thread("settled", { settledOverride: "settled" }),
              thread("archived", { archivedAt: at(NOW) }),
              thread("active"),
              thread("snoozed", { snoozedUntil: at("2026-06-20T15:00:00.000Z") }),
              thread("pinned", { pinnedAt: at("2026-06-19T00:00:00.000Z") }),
            ],
            projects: [],
            features: ALL,
          },
        ],
        NOW,
      );
      NodeAssert.deepEqual(
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
      NodeAssert.equal(subagent?.parentId, "active");
      NodeAssert.equal(subagent?.rootId, "active");
    },
  );

  NodeTest.test("counts upstream's Waiting as in motion", () => {
    const [waiting] = shellThreads(
      [
        {
          environmentId: "env",
          threads: [thread("t", { latestRunId: RunId.make("run"), status: "idle" })],
          projects: [],
          features: ALL,
        },
      ],
      NOW,
    );
    NodeAssert.equal(waiting?.waiting, true);
    NodeAssert.equal(waiting?.working, true);
  });

  NodeTest.test(
    "dates a card by the user's latest message, a settled one by its settlement, as upstream's rows",
    () => {
      const message = {
        latestUserMessageAt: at("2026-06-20T08:00:00.000Z"),
        updatedAt: at("2026-06-20T11:00:00.000Z"),
      };
      const threads = shellThreads(
        [
          {
            environmentId: "env",
            threads: [
              thread("active", message),
              thread("settled", {
                ...message,
                settledOverride: "settled",
                settledAt: at("2026-06-20T09:00:00.000Z"),
              }),
            ],
            projects: [],
            features: ALL,
          },
        ],
        NOW,
      );
      NodeAssert.deepEqual(
        threads.map((each) => [each.id, each.ageFrom]),
        [
          ["active", "2026-06-20T08:00:00.000Z"],
          ["settled", "2026-06-20T09:00:00.000Z"],
        ],
      );
    },
  );

  NodeTest.test("puts a Star's threads on no shelf, dated by their settlement once asleep", () => {
    const star = {
      ...v2Project,
      id: ProjectId.make("star"),
      workspaceRoot: "/Users/a/.pult/stars/star",
    };
    const asleep = {
      projectId: star.id,
      settledOverride: "settled" as const,
      settledAt: at("2026-06-20T09:00:00.000Z"),
    };
    const threads = shellThreads(
      [
        {
          environmentId: "env",
          threads: [
            thread("awake", { projectId: star.id }),
            thread("asleep", asleep),
            thread("other", { projectId: v2Project.id }),
          ],
          projects: [v2Project, star],
          features: ALL,
        },
      ],
      NOW,
    );
    NodeAssert.deepEqual(
      threads.map((each) => [each.id, each.shelf, each.settled]),
      [
        ["other", "active", false],
        ["awake", null, false],
        ["asleep", null, true],
      ],
    );
    NodeAssert.equal(threads.at(-1)?.ageFrom, "2026-06-20T09:00:00.000Z");
  });

  NodeTest.test(
    "merges the environments' shelves, each thread shelved by its own server's features",
    () => {
      const settled = { settledOverride: "settled" as const };
      const threads = shellThreads(
        [
          { environmentId: "env", threads: [thread("same", settled)], projects: [], features: ALL },
          {
            environmentId: "other",
            threads: [thread("same", settled, "other")],
            projects: [],
            features: NO_THREAD_FEATURES,
          },
        ],
        NOW,
      );
      NodeAssert.deepEqual(
        threads.map((each) => [each.environmentId, each.id, each.shelf]),
        [
          ["other", "same", "active"],
          ["env", "same", "settled"],
        ],
      );
    },
  );
});
