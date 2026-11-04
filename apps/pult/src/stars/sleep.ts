// When a Star falls asleep (xaxis `pult/issues/star-sleep`, the rule of
// `pult/issues/durable-agent-sleep`), apart from the workbench so
// `node --test src/stars/sleep.test.ts` can run it. The page evaluates it on
// a conversation's projection whenever it looks (`conversations.ts`), so a
// deadline that passed while no page was open puts the Star to sleep as soon
// as one sees it.
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long a conversation stays awake after its last turn where the adapter observed no prompt cache TTL. */
export const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

/**
 * Whether a conversation may fall asleep: held awake while a run is on, a
 * subagent of it works, a message is queued, held or not, or a runtime
 * request (an approval, a question) awaits the user; else asleep from `at`,
 * in epoch milliseconds.
 */
export type Wakefulness =
  | { readonly kind: "held"; readonly by: "run" | "subagent" | "queued" | "request" }
  | { readonly kind: "deadline"; readonly at: number };

/**
 * What the rule reads of a conversation's projection. The bounded one
 * `orchestration.getThreadProjection` answers will do: its window always
 * carries the live runs and subagents and the pending requests, whatever
 * their age, and the provider turns of the latest runs.
 */
export type SleepInput = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns" | "runtimeRequests" | "subagents">;

/** A run on, as the server's settle check reads it; a provider turn counts through its run alone, so one a provider left unfinished holds nothing once its run ended. */
const LIVE_RUNS: ReadonlySet<string> = new Set(["preparing", "starting", "running", "waiting"]);
const LIVE_SUBAGENTS: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/**
 * The rule: a conversation falls asleep at its last provider turn's
 * `completedAt` plus the prompt cache TTL the adapter observed for it
 * (`promptCacheTtlMs` on the turn's token usage, else on the latest earlier
 * turn of the same provider thread that reported one, since a request served
 * wholly from the cache reports none while refreshing it), 10 minutes where
 * none was observed. Without a completed provider turn, its latest finished
 * run stands in, else its creation. A conversation un-settled since counts
 * from its un-settlement instead, so waking it by hand does not put it
 * straight back to sleep.
 */
export function wakefulness(projection: SleepInput): Wakefulness {
  if (projection.runs.some((run) => LIVE_RUNS.has(run.status))) return { kind: "held", by: "run" };
  if (projection.subagents.some((subagent) => LIVE_SUBAGENTS.has(subagent.status))) return { kind: "held", by: "subagent" };
  if (projection.runs.some((run) => run.status === "queued")) return { kind: "held", by: "queued" };
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return { kind: "held", by: "request" };
  const { unsettledAt } = projection.thread;
  const from = (base: number) => (unsettledAt == null ? base : Math.max(base, DateTime.toEpochMillis(unsettledAt)));
  const turns = projection.providerTurns
    .flatMap((turn) => (turn.completedAt === null ? [] : [{ turn, completedAt: DateTime.toEpochMillis(turn.completedAt) }]))
    .toSorted((left, right) => left.completedAt - right.completedAt);
  const last = turns.at(-1);
  if (last === undefined) {
    const finished = projection.runs.flatMap((run) => (run.completedAt === null ? [] : [DateTime.toEpochMillis(run.completedAt)]));
    const base = finished.length > 0 ? Math.max(...finished) : DateTime.toEpochMillis(projection.thread.createdAt);
    return { kind: "deadline", at: from(base) + DEFAULT_CACHE_TTL_MS };
  }
  const observed = turns.findLast(({ turn }) => turn.providerThreadId === last.turn.providerThreadId && turn.tokenUsage?.promptCacheTtlMs !== undefined);
  return { kind: "deadline", at: from(last.completedAt) + (observed?.turn.tokenUsage?.promptCacheTtlMs ?? DEFAULT_CACHE_TTL_MS) };
}

/** Whether a conversation with this wakefulness is asleep by `now`. */
export function asleepBy(state: Wakefulness, now: number): boolean {
  return state.kind === "deadline" && now >= state.at;
}
