// A Star is told, once per run by its delivery key, when the latest run of an unsettled thread
// tagged `pult:child:star:<id>` failed other than by a usage limit, in the channel its
// `pult:channel:<slug>` tag names (`pult/decisions`, `star-child-failures`).
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import {
  Cause,
  DateTime,
  Effect,
  ProjectService,
  Scheduler,
  ThreadManagementService,
} from "../host.ts";
import { childTag, taggedChannel } from "./channels.ts";
import type { Deliver } from "./deliver.ts";
import type { Stars } from "./stars.ts";

/** How often the pass looks; the scheduler ticks more often. */
const PASS_INTERVAL_MS = 60_000;
/** How long a run stays failed before it is told: longer than a restart's continuation retries (60 s, then 180 s). */
const GRACE_MS = 5 * 60_000;
/** A run that failed longer ago is never told, so the first pass after a deploy does not flood the Stars. */
const HORIZON_MS = 24 * 60 * 60_000;
const CHILD_TAG_PREFIX = childTag("");

const notInterrupted = <E>(cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause);

export const make = Effect.fn("ChildFailures.make")(function* (
  stars: Pick<Stars, "get">,
  deliver: Deliver,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const scheduler = yield* Scheduler.Scheduler;
  /** The keys told since the server started; one told before a restart replays by its receipt. */
  const told = new Set<string>();

  const tell = Effect.fn("ChildFailures.tell")(function* (
    thread: OrchestrationV2ThreadShell,
    starId: string,
    key: string,
    failedAt: DateTime.Utc,
  ) {
    const star = yield* stars.get(starId);
    // A tag naming no Star of this server's is someone else's.
    if (star === undefined) return;
    const project = yield* projects.getShell(thread.projectId);
    // The thread sender's form (`star-delivery`), as `pult_star_message` writes it.
    const about =
      project._tag === "Some"
        ? `thread ${thread.id} "${thread.title}" in project "${project.value.title}"`
        : `thread ${thread.id} "${thread.title}"`;
    yield* deliver({
      star,
      text: `Its latest run failed at ${DateTime.formatIso(failedAt).slice(11, 16)} UTC and it has stopped: ${thread.lastError ?? "no error recorded"} (${thread.lastErrorClass ?? "unknown"}). It runs again only when it is sent a message. Pult tells you once per failed run; a run stopped by a usage limit is not told.`,
      from: `Pult, about ${about}`,
      key,
      // The thread carries this Star's child tag, so its channel tag counts (`star-channels`).
      to: taggedChannel(thread.tags),
      sender: "plugin",
    });
    told.add(key);
  });

  let lastPass: number | undefined;
  const pass = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (lastPass !== undefined && now - lastPass < PASS_INTERVAL_MS) return;
    lastPass = now;
    const snapshot = yield* threads.getShellSnapshot({ location: "active", unsettledOnly: true });
    for (const thread of snapshot.threads) {
      // Interrupted and cancelled runs are someone's act; a usage limit's stop resumes by itself.
      if (thread.status !== "failed" || thread.lastErrorClass === "usage_limit") continue;
      const failedAt = thread.latestRunCompletedAt;
      if (thread.latestRunId === null || failedAt == null) continue;
      const age = now - DateTime.toEpochMillis(failedAt);
      if (age < GRACE_MS || age > HORIZON_MS) continue;
      const key = `child-run-failed:${thread.id}:${thread.latestRunId}`;
      if (told.has(key)) continue;
      const starIds = (thread.tags ?? [])
        .filter((tag) => tag.startsWith(CHILD_TAG_PREFIX))
        .map((tag) => tag.slice(CHILD_TAG_PREFIX.length));
      if (starIds.length === 0) continue;
      // A Star launches a thread with its own tag alone; a thread of two Stars' is told to neither.
      if (starIds.length > 1) {
        yield* Effect.logWarning(
          "A thread carries two Stars' child tags; its failed run is not told.",
          {
            threadId: thread.id,
            starIds,
          },
        );
        continue;
      }
      yield* tell(thread, starIds[0]!, key, failedAt).pipe(
        Effect.catchCauseIf(notInterrupted, (cause) =>
          Effect.logWarning("Could not tell a Star its thread's run failed.", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCauseIf(notInterrupted, (cause) =>
      Effect.logWarning("Could not look for the Stars' failed threads.", { cause }),
    ),
    Effect.withSpan("ChildFailures.pass"),
  );
  yield* scheduler.register("pult-child-failures", pass);
});
