import { assert, it } from "@effect/vitest";
import type { OrchestrationV2StoredEvent, ScheduledTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as ServerActivity from "./serverActivity.ts";

const runUpdated = { sequence: 1, event: { type: "run.updated" } } as OrchestrationV2StoredEvent;
const task = (lastRunStatus: ScheduledTask["lastRunStatus"]) =>
  ({ lastRunStatus }) as unknown as ScheduledTask;
const dispatching = [task("running")];
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);

const makeHarness = Effect.fnUntraced(function* (initial: {
  readonly work: boolean;
  readonly tasks?: ReadonlyArray<ScheduledTask>;
}) {
  const work = yield* Ref.make<boolean | "fails">(initial.work);
  const tasks = yield* Ref.make<ReadonlyArray<ScheduledTask>>(initial.tasks ?? []);
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const taskChanges = yield* Queue.unbounded<void>();
  const reads = yield* Queue.unbounded<void>();
  const layer = ServerActivity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.fromQueue(events),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          hasActiveWork: () =>
            Queue.offer(reads, undefined).pipe(
              Effect.andThen(Ref.get(work)),
              Effect.filterOrElse(
                (value) => value !== "fails",
                () => Effect.die("projection read failed"),
              ),
            ),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          hasRunningTask: () =>
            Ref.get(tasks).pipe(
              Effect.map((list) => list.some((task) => task.lastRunStatus === "running")),
            ),
          subscribeChanges: () => Stream.fromQueue(taskChanges),
        }),
      ),
    ),
  );
  // A read starts only after the previous one is recorded, so a second read proves the first landed.
  const settle = (signal: Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      yield* signal;
      yield* Queue.take(reads);
      yield* Queue.offer(events, runUpdated);
      yield* Queue.take(reads);
    });
  const current = ServerActivity.ServerActivity.use((activity) => activity.current);
  return {
    layer,
    current,
    boot: Queue.take(reads),
    setWork: (value: boolean | "fails") =>
      settle(Ref.set(work, value).pipe(Effect.andThen(Queue.offer(events, runUpdated)))),
    setTasks: (value: ReadonlyArray<ScheduledTask>) =>
      settle(Ref.set(tasks, value).pipe(Effect.andThen(Queue.offer(taskChanges, undefined)))),
  };
});

it.effect("restingSince is boot when the server starts at rest and moves only on transitions", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000);
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      yield* harness.boot;
      assert.deepEqual(yield* harness.current, { atRest: true, restingSince: at(10) });

      yield* TestClock.adjust("5 seconds");
      yield* harness.setWork(false);
      assert.deepEqual(yield* harness.current, { atRest: true, restingSince: at(10) });

      yield* harness.setWork(true);
      assert.deepEqual(yield* harness.current, { atRest: false, restingSince: null });

      yield* TestClock.adjust("60 seconds");
      yield* harness.setWork(false);
      assert.deepEqual(yield* harness.current, { atRest: true, restingSince: at(75) });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a server that starts busy comes to rest when its work ends", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: true });
    yield* Effect.gen(function* () {
      yield* harness.boot;
      assert.deepEqual(yield* harness.current, { atRest: false, restingSince: null });

      yield* TestClock.adjust("30 seconds");
      yield* harness.setWork(false);
      assert.deepEqual(yield* harness.current, { atRest: true, restingSince: at(30) });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a dispatching scheduled task holds the server busy", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false, tasks: dispatching });
    yield* Effect.gen(function* () {
      yield* harness.boot;
      assert.isFalse((yield* harness.current).atRest);

      yield* TestClock.adjust("1 minute");
      yield* harness.setTasks([task("succeeded")]);
      assert.deepEqual(yield* harness.current, { atRest: true, restingSince: at(60) });

      yield* harness.setTasks(dispatching);
      assert.isFalse((yield* harness.current).atRest);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a failed read counts as busy", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      yield* harness.boot;
      yield* harness.setWork("fails");
      assert.deepEqual(yield* harness.current, { atRest: false, restingSince: null });
    }).pipe(Effect.provide(harness.layer));
  }),
);
