// When a Star's conversation falls asleep (monore `pult/decisions`, `star-sleep`): the page's
// rule as it was (`apps/pult/src/stars/sleep.ts`), read over the server's own records.
import type {
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { DateTime } from "../host.ts";

/** How long a conversation stays awake after its last turn where nothing better is known, and after an un-settlement. */
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

/** When a conversation ends for its size: from this many tokens in its context, or never (`settings.ts`, `rotate-on-context`). */
export type RotateOnContext = number | "never";

/** Held awake by what, or asleep from `at`, in epoch milliseconds. */
export type Wakefulness =
  | {
      readonly kind: "held";
      readonly by: "run" | "subagent" | "queued" | "request" | "background-work" | "usage-limit";
    }
  | { readonly kind: "deadline"; readonly at: number };

export type SleepInput = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "providerTurns" | "runtimeRequests" | "subagents"
>;

/** A run on, as the server's settle check reads it; a provider turn counts through its run alone. */
const LIVE_RUNS: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);
const LIVE_SUBAGENTS: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/**
 * Whether the context reached `tokens` by the newest token usage a provider turn reported, as the
 * context meter reads it; not where no turn reported any. The figure is absolute, whatever the window.
 */
export function contextReached(
  providerTurns: SleepInput["providerTurns"],
  tokens: number,
): boolean {
  let usage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  for (const { tokenUsage } of providerTurns) {
    // Ties go to the later entry, as the meter's do.
    if (
      tokenUsage !== undefined &&
      (usage === undefined || Date.parse(tokenUsage.updatedAt) >= Date.parse(usage.updatedAt))
    )
      usage = tokenUsage;
  }
  return usage !== undefined && usage.usedTokens >= tokens;
}

/**
 * Asleep at the prompt cache expiry, else the last turn's end plus its observed TTL (10 minutes
 * where none), at that end itself once the context reached `rotateOnContext`, or 10 minutes after a later
 * un-settlement; held while a run is on or queued, a subagent works, a request awaits the user,
 * the shell's background work holds as the server's settle check reads it, or `usageLimited`.
 */
export function wakefulness(
  projection: SleepInput,
  promptCacheExpiresAt?: DateTime.Utc | null,
  options: {
    /** Absent, the conversation never ends for its size. */
    readonly rotateOnContext?: RotateOnContext;
    readonly pendingBackgroundTasks?: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
    readonly usageLimited?: boolean;
  } = {},
): Wakefulness {
  if (projection.runs.some((run) => LIVE_RUNS.has(run.status))) return { kind: "held", by: "run" };
  if (projection.subagents.some((subagent) => LIVE_SUBAGENTS.has(subagent.status)))
    return { kind: "held", by: "subagent" };
  if (projection.runs.some((run) => run.status === "queued")) return { kind: "held", by: "queued" };
  if (projection.runtimeRequests.some((request) => request.status === "pending"))
    return { kind: "held", by: "request" };
  if (backgroundWorkHoldsCompletion(options.pendingBackgroundTasks ?? []))
    return { kind: "held", by: "background-work" };
  if (options.usageLimited === true) return { kind: "held", by: "usage-limit" };
  const { unsettledAt } = projection.thread;
  // A full context takes the deadline as passed: the last turn's end, every hold still applying.
  const rotateAt = options.rotateOnContext ?? "never";
  const full = rotateAt !== "never" && contextReached(projection.providerTurns, rotateAt);
  if (promptCacheExpiresAt != null && !full) {
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
  // A hand wake keeps its 10 minutes even when full, so a user can still ask the thread something.
  const fullAt = (base: number) =>
    unsettledAt == null
      ? base
      : Math.max(base, DateTime.toEpochMillis(unsettledAt) + DEFAULT_CACHE_TTL_MS);
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
    return { kind: "deadline", at: full ? fullAt(base) : from(base) + DEFAULT_CACHE_TTL_MS };
  }
  if (full) return { kind: "deadline", at: fullAt(last.completedAt) };
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
