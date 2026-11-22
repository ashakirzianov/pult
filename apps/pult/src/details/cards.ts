import type { DetailsCards, DetailsCardsValue } from "../../view/main.tsx";

let current: DetailsCards | null = null;
let starRenderer: ((element: HTMLElement) => () => void) | undefined;
const listeners = new Set<() => void>();

/**
 * The details cards as the thread view reads them through its host
 * (`view/ThreadDetailsCard.tsx`): which view they float over and what they
 * show, null while they are closed or the active editor is no thread's
 * view, so the rows, and the queries they run, live only while they can be
 * seen, as upstream's card's do. `index.tsx` keeps it.
 */
export const detailsCards: DetailsCardsValue & {
  set(next: DetailsCards | null): void;
  setStarRenderer(render: (element: HTMLElement) => () => void): void;
} = {
  get: () => current,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  renderStar(element) {
    if (starRenderer === undefined)
      throw new Error("A Star's details cards rendered before the shell started them");
    return starRenderer(element);
  },
  set(next) {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    for (const listener of listeners) listener();
  },
  setStarRenderer(render) {
    starRenderer = render;
  },
};
