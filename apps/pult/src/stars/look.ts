// Which of its looks a Star wears (xaxis `pult/issues/star-states`), apart
// from the workbench so `node --test src/stars/look.test.ts` can run it. Its
// coarse state, Asleep, Awake or Working, stays `stars.ts`'s: the card's
// status and the sleep read that one.
import { scopedKey, type ShellThread } from "../threads/store.ts";
import type { State } from "./flat/states.ts";
import { lineageWorks, type StarHome, threadsBelow } from "./stars.ts";

/** The states `pult-star`'s mark draws, each styled by its name (`flat/star.css`). */
export type StarLook =
  | "asleep"
  | "stirring"
  | "thinking"
  | "talking"
  | "finished"
  | "awake"
  | "listening"
  | "delegating"
  | "waiting"
  | "troubled";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** The looks are the mark's states, `pult-star`'s (`flat/states.ts`), name for name: a name only one side has fails the typecheck here. */
export type LooksAreTheMarksStates = Holds<Same<StarLook, State>>;

/** How long a Star looks finished after a conversation's last turn ends. */
export const FINISHED_MS = 3 * 60_000;

/** What the look reads of a thread: its own, or one below the conversation. */
export type LookThread = Pick<
  ShellThread,
  | "environmentId"
  | "id"
  | "rootId"
  | "working"
  | "waiting"
  | "awaitsUser"
  | "assistantStreaming"
  | "latestRun"
>;

/** What the look reads besides the Star. */
export interface LookInputs {
  /** The store's threads, for those below the conversation. */
  readonly threads: ReadonlyArray<LookThread>;
  /** The threads whose composer holds an unsent message, by `scopedKey` (`threadsWithUnsentMessages`). */
  readonly unsent: ReadonlySet<string>;
  /** The projects' drafts that hold an unsent message (`projectDrafts`). */
  readonly drafts: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>;
  readonly now: number;
}

/** Until when the conversation looks finished, its latest run's end plus `FINISHED_MS`; null without one. */
export function finishedUntil(current: Pick<LookThread, "latestRun">): number | null {
  const end = Date.parse(current.latestRun?.finishedAt ?? "");
  return Number.isNaN(end) ? null : end + FINISHED_MS;
}

/** Until when the Star looks finished: the latest of its open channels' `finishedUntil`; null without one. */
export function starFinishedUntil(star: {
  readonly channels: ReadonlyArray<{ readonly thread: Pick<LookThread, "latestRun"> }>;
}): number | null {
  const ends = star.channels.flatMap(({ thread }) => finishedUntil(thread) ?? []);
  return ends.length === 0 ? null : Math.max(...ends);
}

/**
 * A Star's look, read over every open channel's conversation, each state
 * holding when it holds for any. With none open, it is stirring while one
 * of its homes' drafts holds an unsent message, else asleep. Else the first
 * that holds of: troubled, a conversation's latest run failed, a usage
 * limit's stop among them, until its next starts (an interrupted run is
 * not a failure, and ends finished); waiting, a runtime request of a
 * conversation or of a thread below one awaits the user; talking, a
 * conversation works and an assistant message of its run streams, as the
 * shell row says (never for a provider that sends its text whole, as
 * Claude's adapter does, nor from an older server); thinking, a
 * conversation's own run is on, a queued message among it (upstream's
 * Waiting, a run held open by background work, is not its own);
 * delegating, a thread below a conversation works, or its run is held open
 * by background work; listening, a conversation's composer or a home's
 * draft holds an unsent message; finished, for `FINISHED_MS` after a
 * conversation's latest run ended; else awake.
 */
export function starLook(
  star: {
    readonly channels: ReadonlyArray<{ readonly thread: LookThread }>;
    readonly homes: ReadonlyArray<Pick<StarHome, "environmentId" | "projectId">>;
  },
  inputs: LookInputs,
): StarLook {
  const drafted = inputs.drafts.some((draft) =>
    star.homes.some(
      (home) => home.environmentId === draft.environmentId && home.projectId === draft.projectId,
    ),
  );
  if (star.channels.length === 0) return drafted ? "stirring" : "asleep";
  const any = (holds: (thread: LookThread) => boolean) =>
    star.channels.some(({ thread }) => holds(thread));
  if (any((thread) => thread.latestRun?.status === "failed")) return "troubled";
  if (
    any(
      (thread) =>
        thread.awaitsUser || threadsBelow(thread, inputs.threads).some((each) => each.awaitsUser),
    )
  )
    return "waiting";
  if (any((thread) => thread.working && thread.assistantStreaming)) return "talking";
  if (any((thread) => thread.working && !thread.waiting)) return "thinking";
  if (any((thread) => thread.waiting || lineageWorks(thread, inputs.threads))) return "delegating";
  if (drafted || any((thread) => inputs.unsent.has(scopedKey(thread.environmentId, thread.id))))
    return "listening";
  const until = starFinishedUntil(star);
  if (until !== null && inputs.now < until) return "finished";
  return "awake";
}
