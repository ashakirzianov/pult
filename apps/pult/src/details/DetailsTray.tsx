import { useSyncExternalStore } from "react";

import { askStore } from "../asks/model.ts";
import { drawnHome } from "../stars/stars.ts";
import { useStarDetails } from "./DetailsView.tsx";
import { DETAILS_SHELF_ICONS, type DetailsShelfName, detailsShelves } from "./shelves.tsx";
import { starAsks } from "./StarDetails.tsx";

const { ShelfDropLine, shelfDrag, shelfDragHandlers, shelfDropHandlers, shelfOrder, openShelf } =
  detailsShelves;

/**
 * The right panel's tray, on the composer buttons' row while the panel shows
 * (`view/ThreadDetailsCard.tsx`): a Star's closed shelves' icons, each with
 * its count as a badge and dimmed while the shelf holds nothing, a click
 * opening the shelf and a drag moving it as the left tray's do. While a shelf
 * is dragged it takes the row, shown even with no icon, so a header dropped
 * there closes its shelf. Empty and with no drag, it draws nothing.
 */
export function DetailsTray() {
  const { closed } = useSyncExternalStore(shelfOrder.subscribe, shelfOrder.get);
  const dragging = useSyncExternalStore(shelfDrag.subscribe, shelfDrag.get) !== null;
  const asks = useSyncExternalStore(askStore.subscribe, askStore.get);
  const details = useStarDetails();
  if (details === null || (closed.length === 0 && !dragging)) return null;
  const schedules = drawnHome(details.star)?.schedules ?? [];
  const countOf = (shelf: DetailsShelfName): number => {
    switch (shelf) {
      case "asks":
        return starAsks(asks, details.star.id).length;
      case "channels":
        return details.rows.channels.filter((row) => row.thread !== null).length;
      case "schedules":
        return schedules.filter((schedule) => schedule.rule?.startsWith("once, ")).length;
    }
  };
  return (
    <div
      className={`pult-panel-tabs pult-tray-shelves${dragging ? " pult-tray-shelves-dropping" : ""}`}
      aria-label="Closed details shelves"
      {...shelfDropHandlers("tray")}
    >
      {closed.map((shelf) => {
        const { label, icon } = DETAILS_SHELF_ICONS[shelf];
        const count = countOf(shelf);
        const empty =
          shelf === "schedules"
            ? schedules.length === 0
            : shelf === "channels"
              ? details.rows.channels.length === 0
              : count === 0;
        return (
          <button
            key={shelf}
            type="button"
            data-shelf={shelf}
            {...shelfDragHandlers(shelf)}
            title={label}
            aria-label={`Open the ${label} shelf`}
            className={`pult-panel-tab${empty ? " pult-tray-shelf-empty" : ""}`}
            onClick={() => openShelf(shelf)}
          >
            <i className={`codicon codicon-${icon}`} aria-hidden />
            {count === 0 ? null : <span className="pult-panel-tab-badge">{count}</span>}
          </button>
        );
      })}
      <ShelfDropLine place="tray" />
    </div>
  );
}
