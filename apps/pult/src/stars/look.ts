// Which of its five looks a Star wears (`pult/decisions`, `star-states`),
// apart from the workbench so `node --test src/stars/look.test.ts` can run
// it. Its coarse state, Asleep, Awake or Working, stays `stars.ts`'s: the
// sleep reads that one.
import type { ShellThread } from "../threads/store.ts";
import type { State } from "./flat/states.ts";
import { lineageWorks, threadsBelow } from "./stars.ts";

/** The five looks, read from the mark alone, first that holds first. */
export type StarLook = "troubled" | "waiting" | "working" | "awake" | "asleep";

/** The state of `pult-star`'s mark (`flat/states.ts`) each look draws: working is the orbit with its two satellites, the mark's `delegating`. */
export const LOOK_STATES: Readonly<Record<StarLook, State>> = {
  troubled: "troubled",
  waiting: "waiting",
  working: "delegating",
  awake: "awake",
  asleep: "asleep",
};

/** Each look in words: the Star's state line in the Details column and its square's label. */
export const LOOK_WORDS: Readonly<Record<StarLook, string>> = {
  troubled: "Troubled",
  waiting: "Waiting",
  working: "Working",
  awake: "Awake",
  asleep: "Asleep",
};

/** What the look reads of a thread: its own, or one below the conversation. */
export type LookThread = Pick<
  ShellThread,
  "environmentId" | "id" | "rootId" | "working" | "awaitsUser" | "latestRun"
>;

/**
 * A Star's look, read over every open channel's conversation, each look
 * holding when it holds for any; asleep with none open. Else the first that
 * holds of: troubled, a conversation's latest run failed, a usage limit's
 * stop among them, until its next starts (an interrupted run is not a
 * failure); waiting, a runtime request of a conversation or of a thread
 * below one awaits the user; working, a conversation's run is on, a queued
 * message or a run held open by background work among it, or a thread
 * below one works; else awake.
 */
export function starLook(
  star: { readonly channels: ReadonlyArray<{ readonly thread: LookThread }> },
  threads: ReadonlyArray<LookThread>,
): StarLook {
  if (star.channels.length === 0) return "asleep";
  const any = (holds: (thread: LookThread) => boolean) =>
    star.channels.some(({ thread }) => holds(thread));
  if (any((thread) => thread.latestRun?.status === "failed")) return "troubled";
  if (
    any(
      (thread) =>
        thread.awaitsUser || threadsBelow(thread, threads).some((each) => each.awaitsUser),
    )
  )
    return "waiting";
  if (any((thread) => thread.working || lineageWorks(thread, threads))) return "working";
  return "awake";
}
