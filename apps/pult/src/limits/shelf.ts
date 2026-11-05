import { openShelf } from "../panel/shelves.tsx";

/**
 * Whether the Limits shelf shows everything, the windows that do not warn
 * too (its Show all, or Pult: Show Usage Limits), for its component and the
 * command; closing the shelf drops it, and a reload forgets it. Whether the
 * shelf is open is the panel's (`src/panel/shelves.tsx`).
 */
let showAll = false;
const listeners = new Set<() => void>();

export const limitsShowAll = {
  get: () => showAll,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Shows everything, or the warning windows alone (Show all, Show less). */
export function setLimitsShowAll(next: boolean): void {
  if (next === showAll) return;
  showAll = next;
  for (const listener of listeners) listener();
}

/** Pult: Show Usage Limits: the shelf opened with everything, brought into view. */
export function revealLimits(): void {
  setLimitsShowAll(true);
  openShelf("limits");
}
