import { getService } from "@codingame/monaco-vscode-api";
import {
  type IAction,
  Separator,
  toAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { type ComponentProps, type RefObject, useEffect, useSyncExternalStore } from "react";

import { flatStill } from "../stars/flat/star.ts";
import markCss from "../stars/flat/star.css?raw";

import {
  closeIn,
  DEFAULT_SHELF_ORDER,
  moveIn,
  openIn,
  PANEL_SHELVES,
  type PanelShelf,
  parseShelfOrder,
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
const OLD_ORDER_KEY = "pult-shell.panel.shelves";
const ORDER_KEY = "pult-shell.panel.shelves.v2";
/** Where each shelf kept whether it was closed before the order, read once as the first closed list. */
const legacyClosedKey = (shelf: PanelShelf) => `pult-shell.panel.${shelf}-closed`;

/** The order stored under `key`, or `fallback` where none is, or what is there is no order of `names`. */
export function readShelfOrder<Name extends string>(
  key: string,
  names: ReadonlyArray<Name>,
  fallback: ShelfOrder<Name>,
): ShelfOrder<Name> {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  const order = parseShelfOrder(parseJson(stored), names);
  if (order !== null) return order;
  console.error(`Pult: ${key} holds no shelf order; the panel starts from its default.`);
  return fallback;
}

function loadOrder(): ShelfOrder {
  if (localStorage.getItem(ORDER_KEY) !== null)
    return readShelfOrder(ORDER_KEY, PANEL_SHELVES, DEFAULT_SHELF_ORDER);
  if (localStorage.getItem(OLD_ORDER_KEY) !== null) {
    const order = readShelfOrder(OLD_ORDER_KEY, PANEL_SHELVES, DEFAULT_SHELF_ORDER);
    const open = PANEL_SHELVES.filter((name) => order.open.includes(name));
    const previous = [...PANEL_SHELVES.slice(0, -2), "settled", "limits"].filter((name) =>
      order.open.includes(name as PanelShelf),
    );
    const migrated = previous.every((name, index) => order.open[index] === name)
      ? { open, closed: order.closed }
      : order;
    localStorage.setItem(ORDER_KEY, JSON.stringify(migrated));
    return migrated;
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

/** Where a shelf can be dropped: its panel, or its panel's tray. */
export type ShelfPlace = "open" | "tray";

const listOf = (place: ShelfPlace) => (place === "open" ? "open" : "closed");

/**
 * A shelf being dragged, by its header in the panel or its icon in the tray,
 * and where a drop would put it: before `before` in `place`'s list, at its
 * end while null, the drop line `at` that many pixels into the place's
 * content along its axis; no target while the pointer is over no place or a
 * drop there would change nothing.
 */
interface ShelfDrag<Name extends string> {
  readonly shelf: Name;
  readonly target: {
    readonly place: ShelfPlace;
    readonly before: Name | null;
    readonly at: number;
  } | null;
}

/**
 * One panel's shelves in their two lists, kept in localStorage under `key`:
 * the open ones in the panel's order, top to bottom, and the closed ones in
 * its tray's order. Opening a shelf puts it at the panel's end
 * (`openIn`), closing one at the tray's end; dragging moves it within
 * or between them. A drag stays in its panel: the other's places take no drop.
 */
export function createShelves<Name extends string>(key: string, initial: ShelfOrder<Name>) {
  let order = initial;
  /** The latest ask to bring an opened shelf into view, numbered so a shelf answers each once. */
  let reveal: { readonly shelf: Name; readonly serial: number } | null = null;
  let revealed = 0;
  let drag: ShelfDrag<Name> | null = null;
  const listeners = new Set<() => void>();

  function update(next: ShelfOrder<Name>): void {
    if (next !== order) {
      order = next;
      localStorage.setItem(key, JSON.stringify(order));
    }
    for (const listener of listeners) listener();
  }

  const shelfOrder = {
    get: () => order,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function setDrag(next: ShelfDrag<Name> | null): void {
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

  /** Where a drop at the pointer puts `shelf` in `place`, null where it changes nothing. */
  function aim(
    event: React.DragEvent<HTMLElement>,
    place: ShelfPlace,
    shelf: Name,
  ): ShelfDrag<Name>["target"] {
    const vertical = place === "open";
    const container = event.currentTarget;
    const box = container.getBoundingClientRect();
    // Along the place's axis, in the container's content, its scroll included.
    const reverse = !vertical && getComputedStyle(container).flexDirection === "row-reverse";
    const offset = (edge: number) =>
      vertical
        ? edge - box.top + container.scrollTop
        : reverse
          ? box.right - edge - container.scrollLeft
          : edge - box.left + container.scrollLeft;
    const pointer = offset(vertical ? event.clientY : event.clientX);
    const shown = [...container.querySelectorAll<HTMLElement>(":scope > [data-shelf]")].map(
      (element) => {
        const rect = element.getBoundingClientRect();
        const start = offset(vertical ? rect.top : reverse ? rect.right : rect.left);
        const end = offset(vertical ? rect.bottom : reverse ? rect.left : rect.right);
        return { name: element.dataset.shelf as Name, start, end };
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
    const edge = (name: Name | undefined) => shown.find((each) => each.name === name);
    const at = edge(placed[index + 1])?.start ?? edge(placed[index - 1])?.end ?? 0;
    return { place, before, at: reverse ? container.clientWidth - at : at };
  }

  const shelfDrag = { get: () => drag, subscribe: shelfOrder.subscribe };

  return {
    shelfOrder,
    shelfDrag,
    /** Closes the shelf, its icon at the tray's end, or at `at` among the closed. */
    closeShelf(shelf: Name, at?: number): void {
      update(closeIn(order, shelf, at));
    },
    /** Opens the shelf at the panel's end (`openIn`), an open one kept in place, and brings it into view (`useReveal`). */
    openShelf(shelf: Name): void {
      reveal = { shelf, serial: (reveal?.serial ?? 0) + 1 };
      update(openIn(order, shelf));
    },
    /** A shelf header's or tray icon's `draggable` handlers: the drag of `shelf`, ended however it ends. */
    shelfDragHandlers(shelf: Name) {
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
    },
    /**
     * The handlers of a place a shelf can be dropped in, the panel's shelves
     * (`open`, top to bottom) or its tray's icons (in the direction they fill), on the
     * element whose children carrying `data-shelf` are the place's shown
     * shelves. A drop goes before the first shelf whose middle is past the
     * pointer, or at the end, and runs `onDrop` with the shelf when it moved.
     */
    shelfDropHandlers(place: ShelfPlace, onDrop: (shelf: Name) => void = () => {}) {
      return {
        onDragOver(event: React.DragEvent<HTMLElement>) {
          if (drag === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDrag({ shelf: drag.shelf, target: aim(event, place, drag.shelf) });
        },
        onDragLeave(event: React.DragEvent<HTMLElement>) {
          if (drag === null || event.currentTarget.contains(event.relatedTarget as Node | null))
            return;
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
    },
    /** The line where a shelf dragged over `place` would drop, in that place's element. */
    ShelfDropLine({ place }: { place: ShelfPlace }) {
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
    },
    /** Scrolls the shelf's `element` into view once for each `openShelf` of it. */
    useReveal(shelf: Name, element: RefObject<HTMLElement | null>): void {
      const asked = useSyncExternalStore(shelfOrder.subscribe, () => reveal);
      useEffect(() => {
        if (asked?.shelf !== shelf || asked.serial === revealed) return;
        revealed = asked.serial;
        element.current?.scrollIntoView({ block: "nearest" });
      });
    },
  };
}

/** The Pult tab's shelves, whose tray's rows none of the jumps reach (`jump.ts`). */
export const {
  shelfOrder,
  shelfDrag,
  closeShelf,
  openShelf,
  shelfDragHandlers,
  shelfDropHandlers,
  ShelfDropLine,
  useReveal,
} = createShelves(ORDER_KEY, loadOrder());

/** A left panel shelf's header (`ShelfHeaderFrame`), its icon its tray icon's and its Close and drag the Pult tab's. */
export function ShelfHeader({
  shelf,
  onClose = () => closeShelf(shelf),
  icon = SHELF_ICONS[shelf].icon,
  ...rest
}: Omit<ComponentProps<typeof ShelfHeaderFrame>, "id" | "drag" | "onClose" | "icon"> & {
  shelf: PanelShelf;
  onClose?: () => void;
  /** A codicon before the label, the shelf's own by default. */
  icon?: string;
}) {
  return (
    <ShelfHeaderFrame
      id={shelf}
      icon={icon}
      onClose={onClose}
      drag={shelfDragHandlers(shelf)}
      {...rest}
    />
  );
}

/**
 * A shelf's header in either panel: its label,
 * its `actions` and Close, shown on hover or keyboard focus; its right-click
 * its `menu`, then Close Shelf. `title` is its tooltip. `icon` leads the
 * label. With `onOpen`, the label is a button running it, `openTitle` its
 * tooltip, highlighted while `selected`: the Explorer shelf's, opening the
 * Explorer tab. Dragged, it moves the shelf (`drag`, `shelfDragHandlers`).
 */
export function ShelfHeaderFrame({
  id,
  label,
  title,
  actions = null,
  menu = [],
  onClose,
  icon,
  drag,
  onOpen,
  openTitle,
  selected = false,
}: {
  id: string;
  label: string;
  title?: string | undefined;
  actions?: React.ReactNode;
  menu?: ReadonlyArray<IAction>;
  onClose: () => void;
  icon: string;
  drag: { draggable: boolean; onDragStart(event: React.DragEvent): void; onDragEnd(): void };
  onOpen?: (() => void) | undefined;
  openTitle?: string | undefined;
  selected?: boolean;
}) {
  const heading = (
    <>
      <ShelfIcon icon={icon} className="pult-shelf-icon" />
      <span className="pult-shelf-label">{label}</span>
    </>
  );
  return (
    <div
      className={`pult-shelf-header pult-shelf-header-closable${selected ? " pult-shelf-header-selected" : ""}`}
      title={title}
      {...drag}
      onContextMenu={(event) => {
        event.preventDefault();
        void showShelfMenu({ x: event.clientX, y: event.clientY }, [
          ...menu,
          ...(menu.length > 0 ? [new Separator()] : []),
          toAction({ id: `pult-shell.closeShelf.${id}`, label: "Close Shelf", run: onClose }),
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
