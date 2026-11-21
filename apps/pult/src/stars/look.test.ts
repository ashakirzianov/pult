// Run with `node --test src/stars/look.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { type LookThread, starLook } from "./look.ts";

const ENDED = "2026-11-06T10:00:00.000Z";

const thread = (id: string, overrides: Partial<LookThread> = {}): LookThread => ({
  environmentId: "a",
  id,
  rootId: id,
  working: false,
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
/** The look of a Star whose one open channel is `user`, in `current`; none open for null. */
const look = (current: LookThread | null, threads: ReadonlyArray<LookThread> = []) =>
  starLook({ channels: current === null ? [] : [{ thread: current }] }, threads);
/** The look of a Star with these conversations open, one channel each. */
const lookOver = (open: ReadonlyArray<LookThread>, threads: ReadonlyArray<LookThread> = []) =>
  starLook({ channels: open.map((each) => ({ thread: each })) }, threads);

NodeTest.describe("starLook", () => {
  NodeTest.test("is asleep without an open channel, awake with an idle one", () => {
    NodeAssert.equal(look(null), "asleep");
    NodeAssert.equal(look(thread("conversation")), "awake");
    NodeAssert.equal(look(thread("conversation", { latestRun: null })), "awake");
  });

  NodeTest.test(
    "is troubled after a failed run until the next starts, an interrupted one awake",
    () => {
      NodeAssert.equal(
        look(thread("conversation", { latestRun: run("failed", ENDED) })),
        "troubled",
      );
      NodeAssert.equal(
        look(thread("conversation", { working: true, latestRun: run("running") })),
        "working",
      );
      NodeAssert.equal(
        look(thread("conversation", { latestRun: run("interrupted", ENDED) })),
        "awake",
      );
    },
  );

  NodeTest.test(
    "works while its run is on, queued or held open by background work, or a thread below works",
    () => {
      NodeAssert.equal(
        look(thread("conversation", { working: true, latestRun: run("queued") })),
        "working",
      );
      NodeAssert.equal(look(thread("conversation", { working: true })), "working");
      NodeAssert.equal(
        look(thread("conversation"), [subagent("child", { working: true })]),
        "working",
      );
      NodeAssert.equal(
        look(thread("conversation"), [subagent("child", { working: true, environmentId: "b" })]),
        "awake",
      );
    },
  );

  NodeTest.test("waits while a runtime request of it or below it awaits the user", () => {
    NodeAssert.equal(look(thread("conversation", { awaitsUser: true })), "waiting");
    NodeAssert.equal(
      look(thread("conversation"), [subagent("child", { awaitsUser: true })]),
      "waiting",
    );
  });

  NodeTest.test("takes troubled, waiting, working in that order", () => {
    NodeAssert.equal(
      look(thread("conversation", { awaitsUser: true, latestRun: run("failed", ENDED) })),
      "troubled",
    );
    NodeAssert.equal(
      look(thread("conversation", { awaitsUser: true, working: true, latestRun: run("running") })),
      "waiting",
    );
  });
});

NodeTest.describe("starLook over several channels", () => {
  const idle = thread("user");
  const failed = thread("work", { latestRun: run("failed", ENDED) });
  const asking = thread("review", { awaitsUser: true });
  const working = thread("work", { working: true, latestRun: run("running") });

  NodeTest.test("takes each look when it holds for any open channel, `user` idle", () => {
    NodeAssert.equal(lookOver([idle, failed]), "troubled");
    NodeAssert.equal(lookOver([idle, asking]), "waiting");
    NodeAssert.equal(lookOver([idle, working]), "working");
    NodeAssert.equal(
      lookOver([idle, thread("work")], [subagent("child", { rootId: "work", working: true })]),
      "working",
    );
    NodeAssert.equal(lookOver([idle, thread("work")]), "awake");
  });

  NodeTest.test("reads each channel from the store's live rows, not the Star's own", () => {
    NodeAssert.equal(lookOver([idle], [thread("user", { awaitsUser: true })]), "waiting");
    NodeAssert.equal(lookOver([idle], [thread("user", { working: true })]), "working");
  });

  NodeTest.test("keeps the precedence across channels", () => {
    NodeAssert.equal(lookOver([working, asking]), "waiting");
    NodeAssert.equal(lookOver([asking, failed]), "troubled");
  });

  NodeTest.test("is awake, never asleep, while another channel is open and `user` sleeps", () => {
    NodeAssert.equal(lookOver([thread("work")]), "awake");
    NodeAssert.equal(lookOver([]), "asleep");
  });
});
