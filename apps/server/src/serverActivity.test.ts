import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerActivity from "./serverActivity.ts";

const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
const current = ServerActivity.ServerActivity.use((activity) => activity.current);

// A fiber the test clock wakes, so `TestClock.adjust` returns only once everything it set off,
// the watch's reread included, has settled.
const inOneSecond = (effect: Effect.Effect<unknown>) =>
  Effect.forkChild(Effect.sleep("1 second").pipe(Effect.andThen(effect))).pipe(
    Effect.andThen(TestClock.adjust("1 second")),
  );

// The mock watch reads only the fields the service reads.
const stored = (event: object) => ({ sequence: 1, event }) as OrchestrationV2StoredEvent;
const runEvent = (status: OrchestrationV2Run["status"]) =>
  stored({ type: "run.updated", payload: { status } });

const makeHarness = Effect.fnUntraced(function* (initial: {
  readonly work: boolean;
  readonly dispatching?: boolean;
}) {
  const work = yield* Ref.make<boolean | "fails">(initial.work);
  const dispatching = yield* Ref.make(initial.dispatching ?? false);
  const newSubscription = Queue.unbounded<
    OrchestrationV2StoredEvent,
    EventSink.EventSinkStreamError
  >();
  const events = yield* Ref.make(yield* newSubscription);
  const taskChanges = yield* Queue.unbounded<void>();
  const layer = ServerActivity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSink.EventSinkV2)({
          latestSequence: () => Effect.succeed(0),
          stream: () => Stream.unwrap(Ref.get(events).pipe(Effect.map(Stream.fromQueue))),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          hasActiveWork: () =>
            Ref.get(work).pipe(
              Effect.filterOrElse(
                (value) => value !== "fails",
                () => Effect.die("projection read failed"),
              ),
            ),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          hasRunningTask: () => Ref.get(dispatching),
          subscribeChanges: () => Stream.fromQueue(taskChanges),
        }),
      ),
    ),
  );
  const deliver = (event: OrchestrationV2StoredEvent) =>
    Ref.get(events).pipe(Effect.flatMap((queue) => Queue.offer(queue, event)));
  return {
    layer,
    /** Changes the store's answer, then delivers the event, a second later. */
    signal: (value: boolean | "fails", event: OrchestrationV2StoredEvent) =>
      inOneSecond(Ref.set(work, value).pipe(Effect.andThen(deliver(event)))),
    setWork: (value: boolean | "fails") =>
      inOneSecond(
        Ref.set(work, value).pipe(
          Effect.andThen(deliver(runEvent(value === false ? "completed" : "running"))),
        ),
      ),
    setDispatching: (value: boolean) =>
      inOneSecond(
        Ref.set(dispatching, value).pipe(Effect.andThen(Queue.offer(taskChanges, undefined))),
      ),
    /** Fails the event stream a second later; a resubscription gets a fresh one. */
    failWatch: inOneSecond(
      Effect.gen(function* () {
        const failed = yield* Ref.getAndSet(events, yield* newSubscription);
        yield* Queue.fail(failed, new EventSink.EventSinkStreamError({}));
      }),
    ),
  };
});

it.effect("restingSince is boot when the server starts at rest and moves only on transitions", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000);
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(10) });

      yield* harness.setWork(false);
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(10) });

      yield* harness.setWork(true);
      assert.deepEqual(yield* current, { atRest: false, restingSince: null });

      yield* TestClock.adjust("60 seconds");
      yield* harness.setWork(false);
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(73) });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a server that starts busy comes to rest when its work ends", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: true });
    yield* Effect.gen(function* () {
      assert.deepEqual(yield* current, { atRest: false, restingSince: null });

      yield* TestClock.adjust("29 seconds");
      yield* harness.setWork(false);
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(30) });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a dispatching scheduled task holds the server busy", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false, dispatching: true });
    yield* Effect.gen(function* () {
      assert.isFalse((yield* current).atRest);

      yield* harness.setDispatching(false);
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(1) });

      yield* harness.setDispatching(true);
      assert.isFalse((yield* current).atRest);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a failed read counts as busy", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      yield* harness.setWork("fails");
      assert.deepEqual(yield* current, { atRest: false, restingSince: null });
    }).pipe(Effect.provide(harness.layer));
  }),
);

// Each event ends its subject's work while the store reports work elsewhere, so only a reread
// can make the server busy.
it.effect.each([
  {
    label: "a native subagent ending",
    event: {
      type: "subagent.updated",
      payload: { origin: "provider_native", status: "completed" },
    },
    rereads: true,
  },
  {
    // Its child thread's runs carry the work.
    label: "an app-owned subagent ending",
    event: { type: "subagent.updated", payload: { origin: "app_owned", status: "completed" } },
    rereads: false,
  },
  {
    label: "a request resolving",
    event: {
      type: "runtime-request.updated",
      payload: { status: "resolved", responseCapability: { type: "message" } },
    },
    rereads: true,
  },
  {
    label: "a background roster emptying",
    event: { type: "provider-thread.updated", payload: { pendingBackgroundTasks: [] } },
    rereads: true,
  },
  {
    label: "a streaming item",
    event: { type: "turn-item.updated", payload: { type: "assistant_message" } },
    rereads: false,
  },
])("$label rereads: $rereads", ({ event, rereads }) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      yield* harness.signal(true, stored(event));
      assert.equal((yield* current).atRest, !rereads);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("a failed watch reads busy, then resyncs and watches again", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ work: false });
    yield* Effect.gen(function* () {
      yield* harness.failWatch;
      assert.deepEqual(yield* current, { atRest: false, restingSince: null });

      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(2) });

      yield* harness.setWork(true);
      assert.isFalse((yield* current).atRest);

      // The next failure waits longer.
      yield* harness.setWork(false);
      yield* harness.failWatch;
      yield* TestClock.adjust("1 second");
      assert.isFalse((yield* current).atRest);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* current, { atRest: true, restingSince: at(7) });
    }).pipe(Effect.provide(harness.layer));
  }),
);

describe("with the real event sink", () => {
  const threadId = ThreadId.make("thread:server-activity");
  const provider = ProviderInstanceId.make("codex");
  const now = DateTime.makeUnsafe(0);
  const runId = RunId.make("run:server-activity");
  const threadCreated = {
    type: "thread.created",
    id: EventId.make("event:server-activity:thread"),
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:server-activity"),
      title: "Server activity",
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  } satisfies OrchestrationV2DomainEvent;
  const runCreated = {
    type: "run.created",
    id: EventId.make("event:server-activity:run"),
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make("message:server-activity"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      queuePosition: null,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  } satisfies OrchestrationV2DomainEvent;
  const writeRun = EventSink.EventSinkV2.use((sink) =>
    sink.write({ events: [threadCreated, runCreated] }),
  );

  const layerSink = EventSink.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  );
  const layerNoTasks = Layer.mock(ScheduledTasks.ScheduledTaskService)({
    hasRunningTask: () => Effect.succeed(false),
    subscribeChanges: () => Stream.never,
  });

  it.effect("a run written while the watch is parked reaches it once the server activates", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const layer = ServerActivity.layer.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(ServerActivation, Deferred.await(activation)), layerNoTasks),
        ),
        Layer.provideMerge(layerSink),
      );
      yield* Effect.gen(function* () {
        yield* writeRun;
        assert.isTrue((yield* current).atRest, "parked");
        yield* inOneSecond(Deferred.succeed(activation, undefined));
        assert.isFalse((yield* current).atRest);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a run written just after the first read reaches the watch", () =>
    Effect.gen(function* () {
      // The run lands after the state is read, as a write racing the boot would.
      const layerRacingWrite = Layer.effect(
        ProjectionStore.ProjectionStoreV2,
        Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          const raced = yield* Ref.make(false);
          return {
            ...store,
            hasActiveWork: () =>
              store
                .hasActiveWork()
                .pipe(
                  Effect.tap(() =>
                    Ref.getAndSet(raced, true).pipe(
                      Effect.flatMap((done) =>
                        done
                          ? Effect.void
                          : sink.write({ events: [threadCreated, runCreated] }).pipe(Effect.orDie),
                      ),
                    ),
                  ),
                ),
          };
        }),
      ).pipe(Layer.provide(layerSink));
      const activation = yield* Deferred.make<void>();
      const layer = ServerActivity.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            // After the sink, so its store replaces the sink's.
            layerSink,
            layerRacingWrite,
            Layer.succeed(ServerActivation, Deferred.await(activation)),
            layerNoTasks,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        assert.isTrue((yield* current).atRest, "the first read missed the run");
        yield* inOneSecond(Deferred.succeed(activation, undefined));
        assert.isFalse((yield* current).atRest);
      }).pipe(Effect.provide(layer));
    }),
  );
});
