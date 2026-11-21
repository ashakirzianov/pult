import type { DetailsColumn, DetailsColumnValue } from "../../view/main.tsx";

let rendered: DetailsColumn | null = null;
let shown = false;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * The Details column's element for the selected thread or draft, which
 * `DetailsView` sets while it renders one and the thread view's pane renders
 * upstream's rows into (`view/ThreadDetailsCard.tsx`, through the view's
 * host): null while the column is closed or holds another container, so the
 * rows, and the queries they run, live only while they can be seen, as
 * upstream's card's do.
 */
export const detailsColumn: DetailsColumnValue & {
  set(next: DetailsColumn | null): void;
  show(visible: boolean): void;
} = {
  get: () => (shown ? rendered : null),
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(next) {
    rendered = next;
    if (shown) changed();
  },
  /** Whether the column shows the Details view (`index.tsx`). */
  show(visible) {
    if (shown === visible) return;
    shown = visible;
    changed();
  },
};
