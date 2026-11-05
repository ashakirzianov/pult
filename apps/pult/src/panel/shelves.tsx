import { getService } from "@codingame/monaco-vscode-api";
import {
  type IAction,
  Separator,
  toAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { type RefObject, useEffect, useSyncExternalStore } from "react";

import { CLOSABLE_SHELVES, type ClosableShelf } from "./order.ts";

/** Where a shelf keeps whether it is closed, as upstream keeps its shelves' state. */
const closedKey = (shelf: ClosableShelf) => `pult-shell.panel.${shelf}-closed`;

let closed: ReadonlySet<ClosableShelf> = new Set(
  CLOSABLE_SHELVES.filter((shelf) => localStorage.getItem(closedKey(shelf)) === "true"),
);
/** The latest ask to bring an opened shelf into view, numbered so a shelf answers each once. */
let reveal: { readonly shelf: ClosableShelf; readonly serial: number } | null = null;
let revealed = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The closed shelves of the Pult tab, kept in localStorage, each open until
 * closed: a closed shelf leaves the panel, its icon in the tray
 * (`TrayShelves.tsx`), and its rows the jumps (`jump.ts`).
 */
export const closedShelves = {
  get: () => closed,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function closeShelf(shelf: ClosableShelf): void {
  if (closed.has(shelf)) return;
  closed = new Set([...closed, shelf]);
  localStorage.setItem(closedKey(shelf), "true");
  notify();
}

/** Opens the shelf, from its tray icon or a command, and brings it into view (`useReveal`). */
export function openShelf(shelf: ClosableShelf): void {
  closed = new Set([...closed].filter((each) => each !== shelf));
  localStorage.removeItem(closedKey(shelf));
  reveal = { shelf, serial: (reveal?.serial ?? 0) + 1 };
  notify();
}

/** Scrolls the shelf's `element` into view once for each `openShelf` of it. */
export function useReveal(shelf: ClosableShelf, element: RefObject<HTMLElement | null>): void {
  const asked = useSyncExternalStore(closedShelves.subscribe, () => reveal);
  useEffect(() => {
    if (asked?.shelf !== shelf || asked.serial === revealed) return;
    revealed = asked.serial;
    element.current?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * A closable shelf's header: its label, its count when one is given, its
 * `actions` and Close, shown on hover or keyboard focus; its right-click its
 * `menu`, then Close Shelf. `title` is its tooltip. Closing runs `onClose`,
 * which closes the shelf by default. `icon`, a codicon, leads the label. With `onOpen`, the label is a button
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
  icon,
  onOpen,
  openTitle,
  selected = false,
}: {
  shelf: ClosableShelf;
  label: string;
  count?: number;
  title?: string;
  actions?: React.ReactNode;
  menu?: ReadonlyArray<IAction>;
  onClose?: () => void;
  /** A codicon before the label. */
  icon?: string;
  onOpen?: () => void;
  openTitle?: string;
  selected?: boolean;
}) {
  const heading = (
    <>
      {icon !== undefined ? <i className={`codicon codicon-${icon}`} aria-hidden /> : null}
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
        className="pult-shelf-action pult-shelf-close"
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
