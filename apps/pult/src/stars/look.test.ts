// Run with `node --test src/stars/look.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { FINISHED_MS, finishedUntil, type LookInputs, type LookThread, starLook } from "./look.ts";

const ENDED = "2026-11-06T10:00:00.000Z";
const AFTER = Date.parse(ENDED) + FINISHED_MS;

const thread = (id: string, overrides: Partial<LookThread> = {}): LookThread => ({
  environmentId: "a",
  id,
  rootId: id,
  working: false,
  waiting: false,
  awaitsUser: false,
  latestRun: { status: "completed", startedAt: "2026-11-06T09:59:00.000Z", finishedAt: ENDED },
  ...overrides,
});
const run = (status: string, finishedAt: string | null = null) => ({
  status,
  startedAt: "2026-11-06T09:59:00.000Z",
  finishedAt,
});
const subagent = (id: string, overrides: Partial<LookThread> = {}) =>
  thread(id, { rootId: "conversation", ...overrides });
const homes = [{ environmentId: "a", projectId: "star-project" }];
const inputs = (overrides: Partial<LookInputs> = {}): LookInputs => ({
  threads: [],
  unsent: new Set(),
  drafts: [],
  now: AFTER,
  ...overrides,
});
const look = (current: LookThread | null, overrides: Partial<LookInputs> = {}) =>
  starLook({ current, homes }, inputs(overrides));

NodeTest.describe("starLook", () => {
  NodeTest.test(
    "is asleep without a current conversation, stirring while its draft holds text",
    () => {
      NodeAssert.equal(look(null), "asleep");
      NodeAssert.equal(
        look(null, { drafts: [{ environmentId: "a", projectId: "star-project" }] }),
        "stirring",
      );
      NodeAssert.equal(
        look(null, { drafts: [{ environmentId: "b", projectId: "star-project" }] }),
        "asleep",
      );
    },
  );

  NodeTest.test("is finished for a minute after the last run ends, then awake", () => {
    NodeAssert.equal(look(thread("conversation"), { now: AFTER - 1 }), "finished");
    NodeAssert.equal(look(thread("conversation"), { now: AFTER }), "awake");
    NodeAssert.equal(look(thread("conversation", { latestRun: null })), "awake");
  });

  NodeTest.test(
    "ends an interrupted run finished, a failed one troubled until the next starts",
    () => {
      NodeAssert.equal(
        look(thread("conversation", { latestRun: run("interrupted", ENDED) }), { now: AFTER - 1 }),
        "finished",
      );
      NodeAssert.equal(
        look(thread("conversation", { latestRun: run("failed", ENDED) })),
        "troubled",
      );
      NodeAssert.equal(
        look(thread("conversation", { working: true, latestRun: run("running") })),
        "thinking",
      );
    },
  );

  NodeTest.test("thinks while its own run is on, queued among it", () => {
    NodeAssert.equal(
      look(thread("conversation", { working: true, latestRun: run("queued") })),
      "thinking",
    );
  });

  NodeTest.test(
    "delegates while a thread below works, or its run is held open by background work",
    () => {
      NodeAssert.equal(
        look(thread("conversation"), { threads: [subagent("child", { working: true })] }),
        "delegating",
      );
      NodeAssert.equal(
        look(thread("conversation", { working: true, waiting: true })),
        "delegating",
      );
      NodeAssert.equal(
        look(thread("conversation"), {
          threads: [subagent("child", { working: true, environmentId: "b" })],
        }),
        "awake",
      );
    },
  );

  NodeTest.test("listens while its composer holds text, awake or finished", () => {
    const unsent = new Set(["a/conversation"]);
    NodeAssert.equal(look(thread("conversation"), { unsent }), "listening");
    NodeAssert.equal(look(thread("conversation"), { unsent, now: AFTER - 1 }), "listening");
  });

  NodeTest.test("waits while a runtime request of it or below it awaits the user", () => {
    NodeAssert.equal(look(thread("conversation", { awaitsUser: true })), "waiting");
    NodeAssert.equal(
      look(thread("conversation"), { threads: [subagent("child", { awaitsUser: true })] }),
      "waiting",
    );
  });

  NodeTest.test(
    "takes troubled, waiting, thinking, delegating, listening, finished in that order",
    () => {
      const unsent = new Set(["a/conversation"]);
      const working = [subagent("child", { working: true })];
      NodeAssert.equal(
        look(thread("conversation", { awaitsUser: true, latestRun: run("failed", ENDED) })),
        "troubled",
      );
      NodeAssert.equal(
        look(
          thread("conversation", { awaitsUser: true, working: true, latestRun: run("running") }),
        ),
        "waiting",
      );
      NodeAssert.equal(
        look(thread("conversation", { working: true, latestRun: run("running") }), {
          threads: working,
          unsent,
        }),
        "thinking",
      );
      NodeAssert.equal(look(thread("conversation"), { threads: working, unsent }), "delegating");
    },
  );
});

NodeTest.describe("finishedUntil", () => {
  NodeTest.test("is the latest run's end plus the minute, null without one", () => {
    NodeAssert.equal(finishedUntil(thread("conversation")), AFTER);
    NodeAssert.equal(finishedUntil(thread("conversation", { latestRun: run("running") })), null);
  });
});
