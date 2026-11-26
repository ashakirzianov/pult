import type { DetailsCards, DetailsCardsValue, DetailsModelPicker } from "../../view/main.tsx";

let current: DetailsCards | null = null;
let shelvesRenderer: ((element: HTMLElement) => () => void) | undefined;
let trayRenderer: ((element: HTMLElement) => () => void) | undefined;
const listeners = new Set<() => void>();
let pickers: ReadonlyArray<DetailsModelPicker> = [];
const pickerListeners = new Set<() => void>();

/**
 * The details cards as the thread view reads them through its host
 * (`view/ThreadDetailsPanel.tsx`): which view they float over and what they
 * show, null while they are closed or the active editor shows no details,
 * so the rows, and the queries they run, live only while they can be
 * seen, as upstream's card's do. `index.tsx` keeps it.
 */
export const detailsCards: DetailsCardsValue & {
  set(next: DetailsCards | null): void;
  setShelvesRenderer(render: (element: HTMLElement) => () => void): void;
  setTrayRenderer(render: (element: HTMLElement) => () => void): void;
  /** Asks the view for a model picker in `picker.element` until what it returns removes it. */
  showModelPicker(picker: DetailsModelPicker): () => void;
} = {
  get: () => current,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  renderShelves(element) {
    if (shelvesRenderer === undefined)
      throw new Error("The details' shelves rendered before the shell started them");
    return shelvesRenderer(element);
  },
  renderTray(element) {
    if (trayRenderer === undefined)
      throw new Error("The details tray rendered before the shell registered it");
    return trayRenderer(element);
  },
  set(next) {
    if (
      next?.file === current?.file &&
      JSON.stringify(next?.view) === JSON.stringify(current?.view) &&
      JSON.stringify(next?.subject) === JSON.stringify(current?.subject)
    )
      return;
    current = next;
    for (const listener of listeners) listener();
  },
  setShelvesRenderer(render) {
    shelvesRenderer = render;
  },
  setTrayRenderer(render) {
    trayRenderer = render;
  },
  modelPickers: () => pickers,
  subscribeModelPickers(listener) {
    pickerListeners.add(listener);
    return () => {
      pickerListeners.delete(listener);
    };
  },
  showModelPicker(picker) {
    pickers = [...pickers, picker];
    for (const listener of pickerListeners) listener();
    return () => {
      pickers = pickers.filter((each) => each !== picker);
      for (const listener of pickerListeners) listener();
    };
  },
};
