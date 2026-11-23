import type { DetailsCards, DetailsCardsValue } from "../../view/main.tsx";

let current: DetailsCards | null = null;
let starRenderer: ((element: HTMLElement) => () => void) | undefined;
let trayRenderer: ((element: HTMLElement) => () => void) | undefined;
const listeners = new Set<() => void>();

/**
 * The details cards as the thread view reads them through its host
 * (`view/ThreadDetailsCard.tsx`): which view they float over and what they
 * show, null while they are closed or the active editor shows no details,
 * so the rows, and the queries they run, live only while they can be
 * seen, as upstream's card's do. `index.tsx` keeps it.
 */
export const detailsCards: DetailsCardsValue & {
  set(next: DetailsCards | null): void;
  setStarRenderer(render: (element: HTMLElement) => () => void): void;
  setTrayRenderer(render: (element: HTMLElement) => () => void): void;
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
  renderTray(element) {
    if (trayRenderer === undefined)
      throw new Error("The details tray rendered before the shell registered it");
    return trayRenderer(element);
  },
  set(next) {
    if (
      next?.fileRows === current?.fileRows &&
      JSON.stringify(next?.view) === JSON.stringify(current?.view) &&
      JSON.stringify(next?.subject) === JSON.stringify(current?.subject)
    )
      return;
    current = next;
    for (const listener of listeners) listener();
  },
  setStarRenderer(render) {
    starRenderer = render;
  },
  setTrayRenderer(render) {
    trayRenderer = render;
  },
};
