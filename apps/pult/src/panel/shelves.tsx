import { getService } from "@codingame/monaco-vscode-api";
import {
  type IAction,
  Separator,
  toAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { type RefObject, useEffect, useSyncExternalStore } from "react";

import {
  closeIn,
  DEFAULT_SHELF_ORDER,
  lowerShelves,
  moveIn,
  openIn,
  PANEL_SHELVES,
  type PanelShelf,
  parseShelfOrder,
  type ShelfOrder,
} from "./order.ts";

/** Each shelf's label and codicon, its header's and its tray icon's (`TrayShelves.tsx`). */
export const SHELF_ICONS: Record<PanelShelf, { readonly label: string; readonly icon: string }> = {
  stars: { label: "Stars", icon: "star-empty" },
  explorer: { label: "Explorer", icon: "files" },
  inbox: { label: "Inbox", icon: "inbox" },
  working: { label: "Working", icon: "pulse" },
  snoozed: { label: "Snoozed", icon: "bell-slash" },
  settled: { label: "Settled", icon: "check" },
  limits: { label: "Limits", icon: "dashboard" },
};

/** Where the shelves' order is kept, as upstream keeps its shelves' state. */
const ORDER_KEY = "pult-shell.panel.shelves";
/** Where each shelf kept whether it was closed before the order, read once as the first closed list. */
const legacyClosedKey = (shelf: PanelShelf) => `pult-shell.panel.${shelf}-closed`;

function loadOrder(): ShelfOrder {
  const stored = localStorage.getItem(ORDER_KEY);
  if (stored !== null) {
    const order = parseShelfOrder(parseJson(stored));
    if (order !== null) return order;
    console.error(`Pult: ${ORDER_KEY} holds no shelf order; the panel starts from its default.`);
    return DEFAULT_SHELF_ORDER;
  }
  const order = PANEL_SHELVES.reduce(
    (each, shelf) =>
      localStorage.getItem(legacyClosedKey(shelf)) === "true" ? closeIn(each, shelf) : each,
    DEFAULT_SHELF_ORDER,
  );
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  for (const shelf of PANEL_SHELVES) localStorage.removeItem(legacyClosedKey(shelf));
  return order;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let order = loadOrder();
/** The latest ask to bring an opened shelf into view, numbered so a shelf answers each once. */
let reveal: { readonly shelf: PanelShelf; readonly serial: number } | null = null;
let revealed = 0;
const listeners = new Set<() => void>();

function update(next: ShelfOrder): void {
  if (next !== order) {
    order = next;
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  }
  for (const listener of listeners) listener();
}

/**
 * The Pult tab's shelves in their two lists, kept in localStorage: the open
 * ones in the panel's order, top to bottom, and the closed ones in the tray's
 * (`TrayShelves.tsx`), left to right, whose rows none of the jumps reach
 * (`jump.ts`). Opening a shelf puts it at the end of its group in the panel,
 * a top shelf's after the last top shelf (`openIn`), closing one puts it at
 * the tray's right end.
 */
export const shelfOrder = {
  get: () => order,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Closes the shelf, its icon at the tray's right end, or at `at` among the closed (`openExplorerShelf`'s undoing). */
export function closeShelf(shelf: PanelShelf, at?: number): void {
  update(closeIn(order, shelf, at));
}

/** Opens the shelf at the end of its group in the panel (`openIn`), from its tray icon or a command, an open one kept in place, and brings it into view (`useReveal`). */
export function openShelf(shelf: PanelShelf): void {
  reveal = { shelf, serial: (reveal?.serial ?? 0) + 1 };
  update(openIn(order, shelf));
}

/**
 * A shelf being dragged, by its header in the panel or its icon in the tray,
 * and where a drop would put it: before `before` in `list`, at its end while
 * null, the drop line `at` that many pixels into the list's content along its
 * axis; no target while the pointer is over neither list or a drop there
 * would change nothing.
 */
export interface ShelfDrag {
  readonly shelf: PanelShelf;
  readonly target: {
    readonly list: keyof ShelfOrder;
    readonly before: PanelShelf | null;
    readonly at: number;
  } | null;
}

let drag: ShelfDrag | null = null;

function setDrag(next: ShelfDrag | null): void {
  const same =
    next === drag ||
    (next !== null &&
      drag !== null &&
      next.shelf === drag.shelf &&
      next.target?.list === drag.target?.list &&
      next.target?.before === drag.target?.before &&
      next.target?.at === drag.target?.at);
  if (same) return;
  drag = next;
  for (const listener of listeners) listener();
}

export const shelfDrag = { get: () => drag, subscribe: shelfOrder.subscribe };

/** A shelf header's or tray icon's `draggable` handlers: the drag of `shelf`, ended however it ends. */
export function shelfDragHandlers(shelf: PanelShelf) {
  return {
    draggable: true,
    onDragStart(event: React.DragEvent) {
      event.dataTransfer.effectAllowed = "move";
      // Some data, without which Chromium starts no drag; the shelf itself is `drag`'s.
      event.dataTransfer.setData("application/x-pult-shelf", shelf);
      setDrag({ shelf, target: null });
    },
    onDragEnd: () => setDrag(null),
  };
}

/**
 * The handlers of a list a shelf can be dropped in, the panel's shelves
 * (`open`, top to bottom) or the tray's icons (`closed`, left to right), on
 * the element whose children carrying `data-shelf` are the list's shown
 * shelves. A drop goes before the first shelf whose middle is past the
 * pointer, or at the end, and runs `onDrop` with the shelf when it moved.
 */
export function shelfDropHandlers(
  list: keyof ShelfOrder,
  onDrop: (shelf: PanelShelf) => void = () => {},
) {
  const vertical = list === "open";
  return {
    onDragOver(event: React.DragEvent<HTMLElement>) {
      if (drag === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDrag({ shelf: drag.shelf, target: aim(event, list, vertical, drag.shelf) });
    },
    onDragLeave(event: React.DragEvent<HTMLElement>) {
      if (drag === null || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDrag({ shelf: drag.shelf, target: null });
    },
    onDrop(event: React.DragEvent<HTMLElement>) {
      if (drag === null) return;
      event.preventDefault();
      const { shelf, target } = drag;
      setDrag(null);
      if (target === null) return;
      update(moveIn(order, shelf, target.list, target.before));
      onDrop(shelf);
    },
  };
}

/** Where a drop at the pointer puts `shelf` in `list`, null where it changes nothing. */
function aim(
  event: React.DragEvent<HTMLElement>,
  list: keyof ShelfOrder,
  vertical: boolean,
  shelf: PanelShelf,
): ShelfDrag["target"] {
  const container = event.currentTarget;
  const box = container.getBoundingClientRect();
  // Along the list's axis, in the container's content, its scroll included.
  const offset = (edge: number) =>
    vertical ? edge - box.top + container.scrollTop : edge - box.left + container.scrollLeft;
  const pointer = offset(vertical ? event.clientY : event.clientX);
  const shown = [...container.querySelectorAll<HTMLElement>(":scope > [data-shelf]")].map(
    (element) => {
      const rect = element.getBoundingClientRect();
      const start = offset(vertical ? rect.top : rect.left);
      const end = offset(vertical ? rect.bottom : rect.right);
      return { name: element.dataset.shelf as PanelShelf, start, end };
    },
  );
  const before = shown.find((each) => (each.start + each.end) / 2 > pointer)?.name ?? null;
  if (moveIn(order, shelf, list, before) === order) return null;
  const others = shown.filter((each) => each.name !== shelf);
  const next = before === null ? others.length : others.findIndex((each) => each.name === before);
  // In the panel a shelf joining the top group lands under the shelf before it, however far below the lower ones are.
  const landsLow =
    !vertical ||
    lowerShelves(others.map((each) => each.name).toSpliced(next, 0, shelf)).includes(shelf);
  const at = landsLow
    ? (others[next]?.start ?? others.at(-1)?.end ?? 0)
    : (others[next - 1]?.end ?? 0);
  return { list, before, at };
}

/** The line where a shelf dragged over `list` would drop, in that list's element (`shelfDropHandlers`). */
export function ShelfDropLine({ list }: { list: keyof ShelfOrder }) {
  const target = useSyncExternalStore(shelfDrag.subscribe, shelfDrag.get)?.target;
  if (target?.list !== list) return null;
  return list === "open" ? (
    <li className="pult-shelf-drop-line" style={{ top: target.at }} aria-hidden />
  ) : (
    <span
      className="pult-shelf-drop-line pult-shelf-drop-line-tray"
      style={{ left: target.at }}
      aria-hidden
    />
  );
}

/** Scrolls the shelf's `element` into view once for each `openShelf` of it. */
export function useReveal(shelf: PanelShelf, element: RefObject<HTMLElement | null>): void {
  const asked = useSyncExternalStore(shelfOrder.subscribe, () => reveal);
  useEffect(() => {
    if (asked?.shelf !== shelf || asked.serial === revealed) return;
    revealed = asked.serial;
    element.current?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * A shelf's header: its label, its count when one is given, its
 * `actions` and Close, shown on hover or keyboard focus; its right-click its
 * `menu`, then Close Shelf. `title` is its tooltip. Closing runs `onClose`,
 * which closes the shelf by default. `icon`, a codicon, leads the label, the
 * shelf's tray icon (`SHELF_ICONS`) by default. With `onOpen`, the label is a button
 * running it, `openTitle` its tooltip, highlighted while `selected`: the
 * Explorer shelf's, opening the Explorer tab. Dragged, it moves the shelf
 * (`shelfDragHandlers`).
 */
export function ShelfHeader({
  shelf,
  label,
  count,
  title,
  actions = null,
  menu = [],
  onClose = () => closeShelf(shelf),
  icon = SHELF_ICONS[shelf].icon,
  onOpen,
  openTitle,
  selected = false,
}: {
  shelf: PanelShelf;
  label: string;
  count?: number;
  title?: string;
  actions?: React.ReactNode;
  menu?: ReadonlyArray<IAction>;
  onClose?: () => void;
  /** A codicon before the label, the shelf's own by default. */
  icon?: string;
  onOpen?: () => void;
  openTitle?: string;
  selected?: boolean;
}) {
  const heading = (
    <>
      <i className={`codicon codicon-${icon} pult-shelf-icon`} aria-hidden />
      <span className="pult-shelf-label">{label}</span>
      {count !== undefined ? <span className="pult-shelf-count">{count}</span> : null}
    </>
  );
  return (
    <div
      className={`pult-shelf-header pult-shelf-header-closable${selected ? " pult-shelf-header-selected" : ""}`}
      title={title}
      {...shelfDragHandlers(shelf)}
      onContextMenu={(event) => {
        event.preventDefault();
        void showShelfMenu({ x: event.clientX, y: event.clientY }, [
          ...menu,
          ...(menu.length > 0 ? [new Separator()] : []),
          toAction({ id: `pult-shell.closeShelf.${shelf}`, label: "Close Shelf", run: onClose }),
        ]);
      }}
    >
      {onOpen === undefined ? (
        <>
          {heading}
          <span className="pult-shelf-spacer" aria-hidden />
        </>
      ) : (
        <button
          type="button"
          className="pult-shelf-open"
          title={openTitle}
          aria-current={selected || undefined}
          onClick={onOpen}
        >
          {heading}
        </button>
      )}
      {actions}
      <button
        type="button"
        className="pult-shelf-action"
        title="Close Shelf"
        aria-label={`Close the ${label} shelf`}
        onClick={onClose}
      >
        <i className="codicon codicon-close" aria-hidden />
      </button>
    </div>
  );
}

async function showShelfMenu(
  anchor: { x: number; y: number },
  actions: ReadonlyArray<IAction>,
): Promise<void> {
  const menus = await getService(IContextMenuService);
  menus.showContextMenu({ getAnchor: () => anchor, getActions: () => actions });
}
