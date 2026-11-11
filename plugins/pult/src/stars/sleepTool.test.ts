import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import { Effect, Layer, ThreadManagementService } from "../host.ts";
import { afterTurn } from "./sleepTool.ts";
import * as Stars from "./stars.ts";
import { at, fakeServer, run } from "./testing.ts";

it.effect("a request sleeps the Star once its turn completed, and not after one that did not", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
    const server = yield* fakeServer;
    const stars = yield* Stars.make.pipe(Effect.provide(server.layer));
    const star = yield* stars.create({ ifNone: true });
    const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(server.layer),
    );
    const asked = (id: string, status: OrchestrationV2Run["status"]) => {
      const thread = server.threads.add(
        star.projectId,
        id,
        { promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z") },
        [run(`${id}-run`, status)],
      );
      return afterTurn(threads, stars, star, {
        projectId: star.projectId,
        threadId: thread.shell.id,
        runId: RunId.make(`${id}-run`),
        calledAt: at("2026-11-10T12:00:30.000Z"),
      });
    };

    // Failed, interrupted, or still on when the wait gave up.
    yield* asked("failed", "failed");
    yield* asked("interrupted", "interrupted");
    yield* asked("running", "running");
    assert.deepStrictEqual(server.threads.settles, []);
    yield* asked("completed", "completed");
    assert.deepStrictEqual(server.threads.settles, ["completed"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
