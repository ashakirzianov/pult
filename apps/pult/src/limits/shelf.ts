import { storedExpanded } from "../panel/collapsible.tsx";

/** Where the Limits shelf keeps whether it is expanded, as the other shelves keep theirs (`EXPANDED_KEYS`, `src/panel/jump.ts`). */
const EXPANDED_KEY = "pult-shell.panel.limits-expanded";

/**
 * The Limits shelf's own state, for its component and the palette's Pult:
 * Show Usage Limits: whether it is expanded, open until closed and kept in
 * localStorage; whether it shows everything whatever the mode (its Show all,
 * or the command), forgotten on reload; and a count of the command's asks
 * to bring it into view.
 */
interface ShelfState {
  readonly expanded: boolean;
  readonly showAll: boolean;
  readonly reveals: number;
}

let state: ShelfState = { expanded: storedExpanded(EXPANDED_KEY, true), showAll: false, reveals: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<ShelfState>): void {
  state = { ...state, ...next };
  if (next.expanded !== undefined) localStorage.setItem(EXPANDED_KEY, String(next.expanded));
  for (const listener of listeners) listener();
}

export const limitsShelfState = {
  get: () => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Expands or collapses the shelf; collapsing it drops Show all. */
export function setLimitsExpanded(expanded: boolean): void {
  set(expanded ? { expanded } : { expanded, showAll: false });
}

/** Shows everything, or what the mode shows (Show all, Show less). */
export function setLimitsShowAll(showAll: boolean): void {
  set({ showAll });
}

/** Pult: Show Usage Limits: the shelf expanded with everything, brought into view. */
export function revealLimits(): void {
  set({ expanded: true, showAll: true, reveals: state.reveals + 1 });
}
