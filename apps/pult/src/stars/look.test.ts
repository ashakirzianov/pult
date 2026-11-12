// Run with `node --test src/stars/look.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  FINISHED_MS,
  finishedUntil,
  type LookInputs,
  type LookThread,
  starFinishedUntil,
  starLook,
} from "./look.ts";

const ENDED = "2026-11-06T10:00:00.000Z";
const AFTER = Date.parse(ENDED) + FINISHED_MS;

const thread = (id: string, overrides: Partial<LookThread> = {}): LookThread => ({
  environmentId: "a",
  id,
  rootId: id,
  working: false,
  waiting: false,
  awaitsUser: false,
  assistantStreaming: false,
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
/** The look of a Star whose one open channel is `user`, in `current`; none open for null. */
const look = (current: LookThread | null, overrides: Partial<LookInputs> = {}) =>
  starLook({ channels: current === null ? [] : [{ thread: current }], homes }, inputs(overrides));
/** The look of a Star with these conversations open, one channel each. */
const lookOver = (threads: ReadonlyArray<LookThread>, overrides: Partial<LookInputs> = {}) =>
  starLook({ channels: threads.map((each) => ({ thread: each })), homes }, inputs(overrides));

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

  NodeTest.test("is finished for three minutes after the last run ends, then awake", () => {
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

  NodeTest.test("talks while its run works and an assistant message streams", () => {
    const talking = { working: true, assistantStreaming: true, latestRun: run("running") };
    NodeAssert.equal(look(thread("conversation", talking)), "talking");
    NodeAssert.equal(
      look(thread("conversation", { ...talking, assistantStreaming: false })),
      "thinking",
    );
    NodeAssert.equal(
      look(thread("conversation", { ...talking, working: false, latestRun: null })),
      "awake",
    );
  });

  NodeTest.test("waits while a runtime request of it or below it awaits the user", () => {
    NodeAssert.equal(look(thread("conversation", { awaitsUser: true })), "waiting");
    NodeAssert.equal(
      look(thread("conversation"), { threads: [subagent("child", { awaitsUser: true })] }),
      "waiting",
    );
  });

  NodeTest.test(
    "takes troubled, waiting, talking, thinking, delegating, listening, finished in that order",
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
        look(
          thread("conversation", {
            awaitsUser: true,
            working: true,
            assistantStreaming: true,
            latestRun: run("running"),
          }),
        ),
        "waiting",
      );
      NodeAssert.equal(
        look(
          thread("conversation", {
            working: true,
            assistantStreaming: true,
            latestRun: run("running"),
          }),
          { threads: working, unsent },
        ),
        "talking",
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

NodeTest.describe("starLook over several channels", () => {
  const idle = thread("user");
  const failed = thread("work", { latestRun: run("failed", ENDED) });
  const asking = thread("review", { awaitsUser: true });
  const thinking = thread("work", { working: true, latestRun: run("running") });

  NodeTest.test("takes each state when it holds for any open channel, `user` idle", () => {
    NodeAssert.equal(lookOver([idle, failed]), "troubled");
    NodeAssert.equal(lookOver([idle, asking]), "waiting");
    NodeAssert.equal(lookOver([idle, thinking]), "thinking");
    NodeAssert.equal(
      lookOver([idle, thread("work")], {
        threads: [subagent("child", { rootId: "work", working: true })],
      }),
      "delegating",
    );
    NodeAssert.equal(
      lookOver([idle, thread("work")], { unsent: new Set(["a/work"]) }),
      "listening",
    );
    NodeAssert.equal(lookOver([idle, thread("work")]), "awake");
  });

  NodeTest.test("keeps the precedence across channels", () => {
    NodeAssert.equal(lookOver([thinking, asking]), "waiting");
    NodeAssert.equal(lookOver([asking, failed]), "troubled");
    NodeAssert.equal(lookOver([thinking, idle], { unsent: new Set(["a/user"]) }), "thinking");
  });

  NodeTest.test("is awake, never asleep, while another channel is open and `user` sleeps", () => {
    NodeAssert.equal(lookOver([thread("work")]), "awake");
    NodeAssert.equal(lookOver([]), "asleep");
  });

  NodeTest.test("listens to a home's draft while any channel is open, stirs with none open", () => {
    const drafts = [{ environmentId: "a", projectId: "star-project" }];
    NodeAssert.equal(lookOver([thread("work")], { drafts }), "listening");
    NodeAssert.equal(lookOver([], { drafts }), "stirring");
  });

  NodeTest.test("is finished until the latest of its channels' runs is three minutes past", () => {
    const later = new Date(Date.parse(ENDED) + 60_000).toISOString();
    const recent = thread("work", { latestRun: run("completed", later) });
    NodeAssert.equal(lookOver([idle, recent], { now: AFTER + 30_000 }), "finished");
    NodeAssert.equal(lookOver([idle, recent], { now: AFTER + 60_000 }), "awake");
    NodeAssert.equal(
      starFinishedUntil({ channels: [{ thread: idle }, { thread: recent }] }),
      AFTER + 60_000,
    );
    NodeAssert.equal(starFinishedUntil({ channels: [] }), null);
  });
});

NodeTest.describe("finishedUntil", () => {
  NodeTest.test("is the latest run's end plus the three minutes, null without one", () => {
    NodeAssert.equal(finishedUntil(thread("conversation")), AFTER);
    NodeAssert.equal(finishedUntil(thread("conversation", { latestRun: run("running") })), null);
  });
});
