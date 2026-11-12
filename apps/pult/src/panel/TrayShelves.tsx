import { useSyncExternalStore } from "react";

import { limitsShelf } from "../limits/limits.ts";
import { limitsStore } from "../limits/model.ts";
import { limitsWeekend } from "../limits/weekend.ts";
import { starStore } from "../stars/model.ts";
import { starEnabled } from "../stars/settings.ts";
import { onDidSelectThread, openExplorerFiles, selectedDraft } from "../threads/selection.ts";
import { type ShelfName, threadStore } from "../threads/store.ts";
import { openExplorerShelf, showThreads } from "./explorer.ts";
import { selectedCardKey, selectionSnapshot } from "./jump.ts";
import { hasNoDraftCard, projectDrafts } from "./drafts.ts";
import { draftCards, draftKey, keyOf, type PanelShelf, starKey } from "./order.ts";
import { useMinuteClock } from "./PanelView.tsx";
import { setLimitsShowAll } from "../limits/shelf.ts";
import {
  openShelf,
  SHELF_ICONS,
  shelfDrag,
  shelfDragHandlers,
  ShelfDropLine,
  shelfDropHandlers,
  shelfOrder,
} from "./shelves.tsx";

/** What a closed shelf's icon tells: its count as a badge, if any; whether it holds nothing; whether it holds the selected card; and its tooltip. */
interface ShelfIcon {
  readonly badge: number | undefined;
  readonly empty: boolean;
  readonly selected: boolean;
  readonly title: string;
}

/** The thread store for `useSyncExternalStore`, at module level so a render does not re-subscribe. */
const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/**
 * The closed shelves' icons from the tray's left end, in the order they
 * were closed, the last closed rightmost (`shelfOrder`), the Stars' none
 * while Show Star is off; a click opens the shelf at the bottom of the Pult
 * tab and brings it into view, the Explorer shelf's the Explorer tab with
 * it, provisionally (`openExplorerShelf`). Each carries its shelf's count as
 * a badge in the accent colour, as Source Control's tab does, but Stars,
 * which has none yet, Settled, whose count is in its tooltip, and Limits,
 * whose badge is the count of warning windows, none while nothing warns;
 * dimmed with no badge while the shelf holds nothing; highlighted as the
 * open tab is while the shelf holds the selected card, the Stars' while a
 * Star is selected, the Explorer shelf's while the Explorer workspace is.
 * An icon dragged moves it in the run, or into the panel, opening its shelf
 * where it drops; while a shelf is dragged the run takes the tray's free
 * room, shown even with no icon, so a shelf's header dropped there closes it.
 */
export function TrayShelves() {
  const { closed: closedShelves } = useSyncExternalStore(shelfOrder.subscribe, shelfOrder.get);
  const starsShown = useSyncExternalStore(starEnabled.subscribe, starEnabled.get);
  const stars = useSyncExternalStore(starStore.subscribe, starStore.get);
  // The Stars' shelf is no shelf at all while Show Star is off.
  const closed = closedShelves.filter((shelf) => shelf !== "stars" || starsShown);
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const { files } = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  const limits = useSyncExternalStore(limitsStore.subscribe, limitsStore.get);
  const weekend = useSyncExternalStore(limitsWeekend.subscribe, limitsWeekend.get);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  const remembered = useSyncExternalStore(projectDrafts.subscribe, projectDrafts.get);
  const dragging = useSyncExternalStore(shelfDrag.subscribe, shelfDrag.get) !== null;
  // Empty, the run shows only while a shelf is dragged, a place to drop it.
  if (closed.length === 0 && !dragging) return null;
  // Read on the selection's change, which re-renders the tray.
  const selectedCard = selectedCardKey();
  const drafts = draftCards(
    remembered,
    selectedDraft(),
    new Set(state.environments.map((environment) => environment.id)),
    hasNoDraftCard,
  );
  const on = (shelf: ShelfName) => state.threads.filter((thread) => thread.shelf === shelf);
  const holdsSelected = (shelf: ShelfName) =>
    on(shelf).some((thread) => keyOf(thread) === selectedCard);
  const icon = (shelf: PanelShelf): ShelfIcon => {
    const { label } = SHELF_ICONS[shelf];
    switch (shelf) {
      case "stars":
        // No count until the Stars have asks.
        return {
          badge: undefined,
          empty: stars.length === 0,
          // As its card in the panel: with the Star, or with one of its conversation's subagents.
          selected: stars.some(
            (star) =>
              starKey(star.id) === selection ||
              (star.current !== null && keyOf(star.current) === selectedCard),
          ),
          title: label,
        };
      case "explorer":
        return {
          badge: undefined,
          empty: state.environments.length === 0 && files.length === 0,
          selected: selection === "explorer",
          title: label,
        };
      case "inbox": {
        // Its cards: the drafts', then the pinned and active threads'.
        const threads = [...on("pinned"), ...on("active")];
        const count = drafts.length + threads.length;
        return {
          badge: count > 0 ? count : undefined,
          empty: count === 0,
          selected:
            threads.some((thread) => keyOf(thread) === selectedCard) ||
            drafts.some((draft) => draftKey(draft) === selectedCard),
          title: label,
        };
      }
      case "working":
      case "snoozed": {
        const count = on(shelf).length;
        return {
          badge: count > 0 ? count : undefined,
          empty: count === 0,
          selected: holdsSelected(shelf),
          title: label,
        };
      }
      case "settled":
        // Every settled thread, the older ones the shells leave out among them, as the shelf's header counts.
        return {
          badge: undefined,
          empty: on("settled").length === 0 && state.settled.count === 0,
          selected: holdsSelected("settled"),
          title: `${label} · ${state.settled.count}`,
        };
      case "limits": {
        const shelfShown = limitsShelf(limits.accounts, now, false, weekend);
        return {
          badge: shelfShown !== null && shelfShown.warnings > 0 ? shelfShown.warnings : undefined,
          empty: shelfShown === null,
          selected: false,
          title: label,
        };
      }
    }
  };
  return (
    <div
      className={`pult-panel-tabs pult-tray-shelves${dragging ? " pult-tray-shelves-dropping" : ""}`}
      aria-label="Closed shelves"
      // Closing Limits by its drop drops its Show all, as its Close does.
      {...shelfDropHandlers("closed", (shelf) => {
        if (shelf === "limits") setLimitsShowAll(false);
      })}
    >
      {closed.map((shelf) => {
        const { badge, empty, selected, title } = icon(shelf);
        return (
          <button
            key={shelf}
            type="button"
            data-shelf={shelf}
            {...shelfDragHandlers(shelf)}
            title={title}
            aria-label={`Open the ${SHELF_ICONS[shelf].label} shelf`}
            className={`pult-panel-tab${selected ? " pult-panel-tab-active" : ""}${empty ? " pult-tray-shelf-empty" : ""}`}
            onClick={() =>
              void (shelf === "explorer"
                ? openExplorerShelf()
                : showThreads().then(() => openShelf(shelf)))
            }
          >
            <i className={`codicon codicon-${SHELF_ICONS[shelf].icon}`} aria-hidden />
            {badge === undefined ? null : <span className="pult-panel-tab-badge">{badge}</span>}
          </button>
        );
      })}
      <ShelfDropLine list="closed" />
    </div>
  );
}
