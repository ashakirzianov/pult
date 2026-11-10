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
 * (`jump.ts`). Opening a shelf puts it at the panel's bottom, closing one
 * puts it at the tray's right end.
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

/** Opens the shelf at the panel's bottom, from its tray icon or a command, an open one kept in place, and brings it into view (`useReveal`). */
export function openShelf(shelf: PanelShelf): void {
  reveal = { shelf, serial: (reveal?.serial ?? 0) + 1 };
  update(openIn(order, shelf));
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
 * Explorer shelf's, opening the Explorer tab.
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
