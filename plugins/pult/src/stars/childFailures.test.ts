import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import { Effect } from "../host.ts";
import * as ChildFailures from "./childFailures.ts";
import { caption, type Deliver, type Delivered, type Delivery } from "./deliver.ts";
import type { Star } from "./stars.ts";
import { at, fakeServer } from "./testing.ts";

const PROJECT = ProjectId.make("project-pult");

/**
 * The pass over a fake server holding one Star, `star-1`, and a project "pult", with a fake
 * `deliver` that records each delivery and fails one whose key holds `behaviour.failing`; `child` adds a
 * thread the Star launched, its latest run failed at 12:00 UTC unless `shell` says otherwise.
 */
const harness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-24T12:10:00Z"));
  const server = yield* fakeServer;
  yield* server.projects.service.create({
    projectId: PROJECT,
    title: "pult",
    workspaceRoot: "/repos/pult",
  });
  const star: Star = {
    id: "star-1",
    name: "Beta",
    description: "",
    tint: "amber",
    created: "2026-11-01T00:00:00.000Z",
    defaultChannel: "main",
    root: "/stars/beta",
    projectId: ProjectId.make("project-star"),
  };
  const deliveries: Delivery[] = [];
  const behaviour: { failing: string | undefined } = { failing: undefined };
  const deliver: Deliver = (delivery) =>
    Effect.suspend(() => {
      deliveries.push(delivery);
      return behaviour.failing !== undefined && delivery.key.includes(behaviour.failing)
        ? Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "down" }))
        : Effect.succeed<Delivered>({ outcome: "launched", threadId: ThreadId.make("woken") });
    });
  yield* ChildFailures.make(
    { get: (id) => Effect.succeed(id === star.id ? star : undefined) },
    deliver,
  ).pipe(Effect.provide(server.layer));
  const child = (id: string, shell: Partial<OrchestrationV2ThreadShell> = {}) =>
    server.threads.add(PROJECT, id, {
      title: `Build ${id}`,
      tags: ["pult:child:star:star-1", "pult:channel:release-42"],
      status: "failed",
      lastError: "Claude API unknown",
      lastErrorClass: "provider_error",
      latestRunId: RunId.make(`${id}-run-1`),
      latestRunCompletedAt: at("2026-11-24T12:00:00Z"),
      ...shell,
    });
  const pass = server.runSource("pult-child-failures");
  const clock = (iso: string) => TestClock.setTime(Date.parse(iso));
  return { server, deliveries, behaviour, child, pass, clock };
}).pipe(Effect.provide(NodeServices.layer));

describe("the child failures pass", () => {
  it.effect("tells the Star's tagged channel of a failed run, once per run", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.child("g5");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      const [told] = h.deliveries;
      assert.strictEqual(told?.star.id, "star-1");
      assert.deepStrictEqual(told?.from, {
        line: 'Pult, about thread g5 "Build g5" in project "pult"',
        caption: caption("From Pult, about", "Build g5", { thread: "g5" }),
      });
      assert.strictEqual(
        told?.text,
        "Its latest run failed at 12:00 UTC and it has stopped: Claude API unknown (provider_error). It runs again only when it is sent a message. Pult tells you once per failed run; a run stopped by a usage limit is not told.",
      );
      assert.strictEqual(told?.key, "child-run-failed:g5:g5-run-1");
      assert.strictEqual(told?.to, "release-42");
      assert.strictEqual(told?.sender, "plugin");

      yield* h.clock("2026-11-24T12:11:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);

      // A second failure, after a message ran it again, is its own run.
      const thread = h.server.threads.byId(ThreadId.make("g5"))!;
      thread.shell = {
        ...thread.shell,
        latestRunId: RunId.make("g5-run-2"),
        latestRunCompletedAt: at("2026-11-24T12:05:00Z"),
      };
      yield* h.clock("2026-11-24T12:12:00Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        ["child-run-failed:g5:g5-run-1", "child-run-failed:g5:g5-run-2"],
      );
    }),
  );

  it.effect("names the default channel and the missing error where the thread has neither", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.child("bare", {
        tags: ["pult:child:star:star-1"],
        lastError: null,
        lastErrorClass: null,
        latestRunCompletedAt: at("2026-11-24T09:41:00Z"),
      });
      yield* h.pass;
      assert.strictEqual(h.deliveries[0]?.to, undefined);
      assert.match(
        h.deliveries[0]?.text ?? "",
        /^Its latest run failed at 09:41 UTC and it has stopped: no error recorded \(unknown\)\./u,
      );
    }),
  );

  it.effect(
    "tells no usage limit's stop, no interrupt or cancel, and no settled or foreign thread",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.child("limited", { lastErrorClass: "usage_limit" });
        h.child("stopped", { status: "interrupted" });
        h.child("cancelled", { status: "cancelled" });
        h.child("settled", { settledOverride: "settled", settledAt: at("2026-11-24T12:01:00Z") });
        h.child("foreign", { tags: ["pult:child:star:star-9", "pult:channel:main"] });
        h.child("untagged", { tags: ["pult:channel:main"] });
        h.child("shared", { tags: ["pult:child:star:star-1", "pult:child:star:star-2"] });
        yield* h.pass;
        assert.deepStrictEqual(h.deliveries, []);
      }),
  );

  it.effect("waits out the grace period and never tells a failure older than a day", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.child("fresh", { latestRunCompletedAt: at("2026-11-24T12:08:00Z") });
      h.child("old", { latestRunCompletedAt: at("2026-11-23T12:09:00Z") });
      yield* h.pass;
      assert.deepStrictEqual(h.deliveries, []);

      yield* h.clock("2026-11-24T12:13:00Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        ["child-run-failed:fresh:fresh-run-1"],
      );
    }),
  );

  it.effect("tries a failed delivery again on the next pass, under the same key", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.child("g5");
      h.child("g6");
      h.behaviour.failing = "g5";
      yield* h.pass;
      // The failure stops no other thread's notice.
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        ["child-run-failed:g5:g5-run-1", "child-run-failed:g6:g6-run-1"],
      );
      h.behaviour.failing = undefined;
      yield* h.clock("2026-11-24T12:11:00Z");
      yield* h.pass;
      yield* h.clock("2026-11-24T12:12:00Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        [
          "child-run-failed:g5:g5-run-1",
          "child-run-failed:g6:g6-run-1",
          "child-run-failed:g5:g5-run-1",
        ],
      );
    }),
  );
});
