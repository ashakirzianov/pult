import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ServerActivitySnapshot,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "./serverActivation.ts";

export class ServerActivity extends Context.Service<
  ServerActivity,
  {
    /** Whether the server is at rest, and since when. */
    readonly current: Effect.Effect<ServerActivitySnapshot>;
  }
>()("t3/serverActivity") {}

// The events that can start or end agent work; streaming items cannot. A deletion ends the
// rosters and native subagents it leaves behind.
const affectsActivity = (event: OrchestrationV2DomainEvent) =>
  event.type === "thread.deleted" ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type === "provider-thread.updated" ||
  (event.type === "subagent.updated" && event.payload.origin === "provider_native");

const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

// The event's own subject is work `hasActiveWork` counts.
const startsWork = (event: OrchestrationV2DomainEvent) => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return (
        ACTIVE_RUN_STATUSES.has(event.payload.status) ||
        (event.payload.status === "queued" && event.payload.queueHeld !== true)
      );
    case "subagent.updated":
      return (
        event.payload.origin === "provider_native" &&
        isOrchestrationV2WorkActive(event.payload.status)
      );
    case "runtime-request.updated":
      return (
        event.payload.status === "pending" && event.payload.responseCapability.type !== "message"
      );
    case "provider-thread.updated":
      return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? []);
    default:
      return false;
  }
};

const watchRestartSchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(1))),
  ),
);

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;

  // A failed read counts as busy, so a broken store never opens a maintenance window.
  const readBusy = Effect.all([projections.hasActiveWork(), scheduledTasks.hasRunningTask()]).pipe(
    Effect.map(([work, dispatching]) => work || dispatching),
    Effect.catchCause((cause) =>
      Effect.logWarning("server-activity.read-failed", { cause }).pipe(Effect.as(true)),
    ),
  );
  const restingSince = yield* Ref.make<DateTime.Utc | null>(null);
  const record = (busy: boolean) =>
    DateTime.now.pipe(
      Effect.flatMap((now) => Ref.update(restingSince, (since) => (busy ? null : (since ?? now)))),
    );

  // Read the sequence before the state, so every later change reaches the stream.
  const resync = eventSink
    .latestSequence()
    .pipe(Effect.tap(() => readBusy.pipe(Effect.flatMap(record))));
  const watchFrom = (afterSequence: number) =>
    Stream.merge(
      eventSink.stream({ afterSequence }).pipe(
        Stream.filter(({ event }) => affectsActivity(event)),
        // Before the coalesced reread, so work that starts and ends within one read still
        // restarts the rest.
        Stream.tap(({ event }) => (startsWork(event) ? record(true) : Effect.void)),
      ),
      scheduledTasks.subscribeChanges(),
    ).pipe(
      // Every signal rereads everything, so a burst needs one read.
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => readBusy.pipe(Effect.flatMap(record))),
    );

  // The first sync runs at construction, so changes written before activation reach the watch.
  const bootSequence = yield* Ref.make(yield* Effect.option(resync));
  const watch = Ref.getAndSet(bootSequence, Option.none()).pipe(
    Effect.flatMap(Option.match({ onNone: () => resync, onSome: Effect.succeed })),
    Effect.flatMap(watchFrom),
    Effect.exit,
    // A stopped watch sees no more changes: busy until a fresh one has synced.
    Effect.flatMap((exit) =>
      Effect.logError("server-activity.watch-stopped", { exit }).pipe(Effect.andThen(record(true))),
    ),
  );
  yield* forkParked(watch.pipe(Effect.repeat(watchRestartSchedule)));

  return ServerActivity.of({
    current: Ref.get(restingSince).pipe(
      Effect.map((since) => ({ atRest: since !== null, restingSince: since })),
    ),
  });
});

export const layer = Layer.effect(ServerActivity, make);
