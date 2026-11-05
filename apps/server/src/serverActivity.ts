import type { OrchestrationV2DomainEvent, ServerActivitySnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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

// The events that can start or end agent work; streaming items cannot.
const affectsActivity = (event: OrchestrationV2DomainEvent) =>
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type === "provider-thread.updated" ||
  (event.type === "subagent.updated" && event.payload.origin === "provider_native");

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;

  // A failed read counts as busy, so a broken store never opens a maintenance window.
  const readBusy = Effect.all([
    projections.hasActiveWork(),
    scheduledTasks
      .list()
      .pipe(Effect.map(({ tasks }) => tasks.some((task) => task.lastRunStatus === "running"))),
  ]).pipe(
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
  const afterSequence = yield* eventSink.latestSequence();
  yield* record(yield* readBusy);
  yield* forkParked(
    Stream.merge(
      eventSink
        .stream({ afterSequence })
        .pipe(Stream.filter(({ event }) => affectsActivity(event))),
      scheduledTasks.subscribeList(),
    ).pipe(
      // Every signal rereads everything, so a burst needs one read.
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => readBusy.pipe(Effect.flatMap(record))),
      // A failed watch sees no more changes, so it stays busy rather than at rest forever.
      Effect.catchCause((cause) =>
        Effect.logError("server-activity.watch-failed", { cause }).pipe(
          Effect.andThen(record(true)),
        ),
      ),
    ),
  );

  return ServerActivity.of({
    current: Ref.get(restingSince).pipe(
      Effect.map((since) => ({ atRest: since !== null, restingSince: since })),
    ),
  });
});

export const layer = Layer.effect(ServerActivity, make);
