// Which of its looks a Star wears (xaxis `pult/issues/star-states`), apart
// from the workbench so `node --test src/stars/look.test.ts` can run it. Its
// coarse state, Asleep, Awake or Working, stays `stars.ts`'s: the card's
// status and the sleep read that one.
import { scopedKey, type ShellThread } from "../threads/store.ts";
import { lineageWorks, type StarHome, threadsBelow } from "./stars.ts";

/**
 * The states `pult-star` draws a look for and Pult shows, its stills named
 * after them (`mark.ts`). `talking`, the current conversation's latest
 * assistant message streaming, is never derived yet: the shell's thread rows
 * carry no streaming flag (`starLook`).
 */
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

/** How long a Star looks finished after its current conversation's last turn ends. */
export const FINISHED_MS = 60_000;

/** What the look reads of a thread: its own, or one below the conversation. */
export type LookThread = Pick<
  ShellThread,
  "environmentId" | "id" | "rootId" | "working" | "waiting" | "awaitsUser" | "latestRun"
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

/**
 * A Star's look. Asleep, it is stirring while one of its homes' drafts holds
 * an unsent message, else asleep. Awake, the first that holds of: troubled,
 * its latest run failed, a usage limit's stop among them, until the next
 * starts (an interrupted run is not a failure, and ends finished); waiting, a
 * runtime request of it or of a thread below it awaits the user; thinking,
 * its own run is on, a queued message among it (upstream's Waiting, a run
 * held open by background work, is not its own); delegating, a thread below
 * it works, or its run is held open by background work; listening, its
 * composer holds an unsent message; finished, for `FINISHED_MS` after its
 * latest run ended; else awake.
 */
export function starLook(
  star: {
    readonly current: LookThread | null;
    readonly homes: ReadonlyArray<Pick<StarHome, "environmentId" | "projectId">>;
  },
  inputs: LookInputs,
): StarLook {
  const { current } = star;
  if (current === null) {
    const stirring = inputs.drafts.some((draft) =>
      star.homes.some(
        (home) => home.environmentId === draft.environmentId && home.projectId === draft.projectId,
      ),
    );
    return stirring ? "stirring" : "asleep";
  }
  if (current.latestRun?.status === "failed") return "troubled";
  if (current.awaitsUser || threadsBelow(current, inputs.threads).some((each) => each.awaitsUser))
    return "waiting";
  if (current.working && !current.waiting) return "thinking";
  if (current.waiting || lineageWorks(current, inputs.threads)) return "delegating";
  if (inputs.unsent.has(scopedKey(current.environmentId, current.id))) return "listening";
  const until = finishedUntil(current);
  if (until !== null && inputs.now < until) return "finished";
  return "awake";
}
