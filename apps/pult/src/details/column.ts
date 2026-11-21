import type { DetailsColumn, DetailsColumnValue } from "../../view/main.tsx";

let current: DetailsColumn | null = null;
const listeners = new Set<() => void>();

/**
 * The Details column's element for the selected thread or draft, which
 * `DetailsView` sets while it renders one and the thread view's pane renders
 * upstream's rows into (`view/ThreadDetailsCard.tsx`, through the view's host).
 */
export const detailsColumn: DetailsColumnValue & { set(next: DetailsColumn | null): void } = {
  get: () => current,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(next) {
    current = next;
    for (const listener of listeners) listener();
  },
};
