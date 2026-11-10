// When a Star's conversation falls asleep (xaxis `pult/decisions`, `star-sleep`): the page's
// rule as it was (`apps/pult/src/stars/sleep.ts`), read over the server's own records.
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { DateTime } from "../host.ts";

/** How long a conversation stays awake after its last turn where nothing better is known, and after an un-settlement. */
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

/** Held awake by what, or asleep from `at`, in epoch milliseconds. */
export type Wakefulness =
  | { readonly kind: "held"; readonly by: "run" | "subagent" | "queued" | "request" }
  | { readonly kind: "deadline"; readonly at: number };

export type SleepInput = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "providerTurns" | "runtimeRequests" | "subagents"
>;

/** A run on, as the server's settle check reads it; a provider turn counts through its run alone. */
const LIVE_RUNS: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);
const LIVE_SUBAGENTS: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/**
 * Asleep at the shell row's prompt cache expiry, or 10 minutes after a later un-settlement; with
 * no expiry, at the last provider turn's `completedAt` plus the TTL the adapter observed on that
 * provider thread (10 minutes where none), else the latest finished run, else the creation; held
 * while a run is on or queued, a subagent works, or a runtime request awaits the user.
 */
export function wakefulness(
  projection: SleepInput,
  promptCacheExpiresAt?: DateTime.Utc | null,
): Wakefulness {
  if (projection.runs.some((run) => LIVE_RUNS.has(run.status))) return { kind: "held", by: "run" };
  if (projection.subagents.some((subagent) => LIVE_SUBAGENTS.has(subagent.status)))
    return { kind: "held", by: "subagent" };
  if (projection.runs.some((run) => run.status === "queued")) return { kind: "held", by: "queued" };
  if (projection.runtimeRequests.some((request) => request.status === "pending"))
    return { kind: "held", by: "request" };
  const { unsettledAt } = projection.thread;
  if (promptCacheExpiresAt != null) {
    const expiresAt = DateTime.toEpochMillis(promptCacheExpiresAt);
    return {
      kind: "deadline",
      at:
        unsettledAt == null
          ? expiresAt
          : Math.max(expiresAt, DateTime.toEpochMillis(unsettledAt) + DEFAULT_CACHE_TTL_MS),
    };
  }
  const from = (base: number) =>
    unsettledAt == null ? base : Math.max(base, DateTime.toEpochMillis(unsettledAt));
  const turns = projection.providerTurns
    .flatMap((turn) =>
      turn.completedAt === null
        ? []
        : [{ turn, completedAt: DateTime.toEpochMillis(turn.completedAt) }],
    )
    .toSorted((left, right) => left.completedAt - right.completedAt);
  const last = turns.at(-1);
  if (last === undefined) {
    const finished = projection.runs.flatMap((run) =>
      run.completedAt === null ? [] : [DateTime.toEpochMillis(run.completedAt)],
    );
    const base =
      finished.length > 0
        ? Math.max(...finished)
        : DateTime.toEpochMillis(projection.thread.createdAt);
    return { kind: "deadline", at: from(base) + DEFAULT_CACHE_TTL_MS };
  }
  // A request served wholly from the cache reports no TTL while refreshing it.
  const observed = turns.findLast(
    ({ turn }) =>
      turn.providerThreadId === last.turn.providerThreadId &&
      turn.tokenUsage?.promptCacheTtlMs !== undefined,
  );
  return {
    kind: "deadline",
    at:
      from(last.completedAt) +
      (observed?.turn.tokenUsage?.promptCacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
  };
}

export function asleepBy(state: Wakefulness, now: number): boolean {
  return state.kind === "deadline" && now >= state.at;
}
