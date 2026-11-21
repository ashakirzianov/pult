import { getService } from "@codingame/monaco-vscode-api";
import {
  type IAction,
  Separator,
  toAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { type RefObject, useEffect, useSyncExternalStore } from "react";

import { flatStill } from "../stars/flat/star.ts";
import markCss from "../stars/flat/star.css?raw";

import {
  closeIn,
  DEFAULT_SHELF_ORDER,
  groupOf,
  moveIn,
  openIn,
  PANEL_SHELVES,
  type PanelShelf,
  parseShelfOrder,
  type ShelfGroup,
  type ShelfOrder,
} from "./order.ts";

/** The Stars' icon, the Star's mark (`ShelfIcon`) where every other shelf's is a codicon. */
const STAR_MARK = "pult-shelf-star-mark";

/** The Star's mark awake, still, as a mask, so `ShelfIcon` draws it in its element's colour as a codicon is. */
const starMarkMask = `url("data:image/svg+xml,${encodeURIComponent(
  flatStill("awake", `${markCss}\n.flat-star { color: #000; --err: #000; }`),
)}")`;

/** Each shelf's label and icon, a codicon or `STAR_MARK`, its header's and its tray icon's (`TrayShelves.tsx`). */
export const SHELF_ICONS: Record<PanelShelf, { readonly label: string; readonly icon: string }> = {
  stars: { label: "Stars", icon: STAR_MARK },
  explorer: { label: "Explorer", icon: "files" },
  inbox: { label: "Inbox", icon: "inbox" },
  working: { label: "Working", icon: "pulse" },
  snoozed: { label: "Snoozed", icon: "bell-slash" },
  settled: { label: "Settled", icon: "check" },
  limits: { label: "Limits", icon: "dashboard" },
};

/** A shelf's icon, `SHELF_ICONS`' or its header's own: the codicon it names, or the Star's mark. */
export function ShelfIcon({ icon, className = "" }: { icon: string; className?: string }) {
  return icon === STAR_MARK ? (
    <i
      className={`pult-shelf-star-mark ${className}`}
      style={{ maskImage: starMarkMask }}
      aria-hidden
    />
  ) : (
    <i className={`codicon codicon-${icon} ${className}`} aria-hidden />
  );
}

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
 * ones in the panel's order, top to bottom, and the closed ones in the
 * trays' (`TrayShelves.tsx`), left to right, each tray its group's, whose
 * rows none of the jumps reach (`jump.ts`). Opening a shelf puts it at the
 * end of its group in the panel (`openIn`), closing one puts it at its
 * tray's right end.
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

/** Where a shelf can be dropped: the panel (`open`), or a group's tray. */
export type ShelfPlace = "open" | ShelfGroup;

const listOf = (place: ShelfPlace): keyof ShelfOrder => (place === "open" ? "open" : "closed");

/**
 * A shelf being dragged, by its header in the panel or its icon in a tray,
 * and where a drop would put it: before `before` in `place`'s list, at its
 * end while null, the drop line `at` that many pixels into the place's
 * content along its axis; no target while the pointer is over no place, over
 * the other group's tray, or a drop there would change nothing.
 */
export interface ShelfDrag {
  readonly shelf: PanelShelf;
  readonly target: {
    readonly place: ShelfPlace;
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
      next.target?.place === drag.target?.place &&
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
 * The handlers of a place a shelf can be dropped in, the panel's shelves
 * (`open`, top to bottom) or a group's tray's icons (left to right), which
 * takes only its group's shelves, on the element whose children carrying
 * `data-shelf` are the place's shown shelves. A drop goes before the first
 * shelf whose middle is past the pointer, or at the end, the panel's kept
 * within the shelf's group (`moveIn`), and runs `onDrop` with the shelf when
 * it moved.
 */
export function shelfDropHandlers(
  place: ShelfPlace,
  onDrop: (shelf: PanelShelf) => void = () => {},
) {
  return {
    onDragOver(event: React.DragEvent<HTMLElement>) {
      if (drag === null || (place !== "open" && groupOf(drag.shelf) !== place)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDrag({ shelf: drag.shelf, target: aim(event, place, drag.shelf) });
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
      update(moveIn(order, shelf, listOf(target.place), target.before));
      onDrop(shelf);
    },
  };
}

/** Where a drop at the pointer puts `shelf` in `place`, null where it changes nothing. */
function aim(
  event: React.DragEvent<HTMLElement>,
  place: ShelfPlace,
  shelf: PanelShelf,
): ShelfDrag["target"] {
  const vertical = place === "open";
  const container = event.currentTarget;
  const box = container.getBoundingClientRect();
  // Along the place's axis, in the container's content, its scroll included.
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
  const list = listOf(place);
  const next = moveIn(order, shelf, list, before);
  if (next === order) return null;
  // The shown shelves around the one dropped, where the drop puts it.
  const placed = next[list].filter(
    (each) => each === shelf || shown.some((other) => other.name === each),
  );
  const index = placed.indexOf(shelf);
  const edge = (name: PanelShelf | undefined) => shown.find((each) => each.name === name);
  const prior = edge(placed[index - 1]);
  const after = edge(placed[index + 1]);
  // In the panel a top shelf lands under the shelf before it, however far below the bottom group is.
  const at =
    vertical && groupOf(shelf) === "top" ? (prior?.end ?? 0) : (after?.start ?? prior?.end ?? 0);
  return { place, before, at };
}

/** The line where a shelf dragged over `place` would drop, in that place's element (`shelfDropHandlers`). */
export function ShelfDropLine({ place }: { place: ShelfPlace }) {
  const target = useSyncExternalStore(shelfDrag.subscribe, shelfDrag.get)?.target;
  if (target?.place !== place) return null;
  return place === "open" ? (
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
      <ShelfIcon icon={icon} className="pult-shelf-icon" />
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
