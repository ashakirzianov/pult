import type { ShellThread, ThreadFeatures } from "./store.ts";

/** What can be done to a thread's place in the list: each true when the server has the feature and the thread's shelf allows it. */
export interface ParkActions {
  readonly settle: boolean;
  readonly unsettle: boolean;
  /** Offered; whether it can be done now is the thread's `canSnooze`. */
  readonly snooze: boolean;
  readonly wake: boolean;
  readonly pin: boolean;
  readonly unpin: boolean;
}

/**
 * A thread's actions, as upstream's thread menu offers them: Settle unless
 * settled, Snooze unless snoozed, Wake while snoozed, Pin or Unpin. A
 * subagent, on no shelf, has none.
 */
export function parkActions(thread: Pick<ShellThread, "shelf" | "pinned">, features: ThreadFeatures): ParkActions {
  const listed = thread.shelf !== null;
  return {
    settle: features.settlement && listed && thread.shelf !== "settled",
    unsettle: features.settlement && thread.shelf === "settled",
    snooze: features.snooze && listed && thread.shelf !== "snoozed",
    wake: features.snooze && thread.shelf === "snoozed",
    pin: features.pinning && listed && !thread.pinned,
    unpin: features.pinning && listed && thread.pinned,
  };
}

/**
 * The card to select once the selected thread `parked` is settled or
 * snoozed, as upstream's `planForwardNavigation`: the next pinned or active
 * thread after it in the store's order, wrapping, skipping threads being
 * parked; null when there is none, and a new thread is due instead.
 */
export function nextAfterParking(
  threads: ReadonlyArray<Pick<ShellThread, "id" | "shelf">>,
  parked: string,
  parking: ReadonlySet<string>,
): string | null {
  const listed = threads.filter((thread) => thread.shelf !== null);
  const index = listed.findIndex((thread) => thread.id === parked);
  const after = [...listed.slice(index + 1), ...listed.slice(0, Math.max(index, 0))];
  return (
    after.find(
      (thread) => (thread.shelf === "pinned" || thread.shelf === "active") && thread.id !== parked && !parking.has(thread.id),
    )?.id ?? null
  );
}
