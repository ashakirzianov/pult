import { useSyncExternalStore } from "react";

import { extensionRows } from "../extensions/index.ts";
import { closedShelves } from "../panel/order.ts";
import { drawnHome } from "../stars/stars.ts";
import { detailsCards } from "./cards.ts";
import { useStarDetails } from "./DetailsView.tsx";
import {
  DETAILS_SHELF_ICONS,
  type DetailsShelfName,
  detailsShelves,
  STAR_SHELVES,
  THREAD_SHELVES,
} from "./shelves.tsx";
import { starRows } from "./StarDetails.tsx";
import { threadShelf, type ThreadSubject, useThreadDetails } from "./ThreadDetails.tsx";

const {
  ShelfDropLine,
  shelfDrag,
  shelfDragHandlers,
  shelfDropHandlers,
  shelfOrder,
  openShelf,
  trayMenu,
} = detailsShelves;

/**
 * The right panel's tray, on the composer buttons' row while the panel shows
 * (`view/ThreadDetailsPanel.tsx`): the closed shelves' icons of what the
 * panel shows, a Star's or a thread's, each with its count as a badge and
 * dimmed while the shelf holds nothing, a click opening the shelf and a drag
 * moving it as the left tray's do. While a shelf is dragged it takes the row,
 * shown even with no icon, so a header dropped there closes its shelf. Empty
 * and with no drag, it draws nothing.
 */
export function DetailsTray() {
  const subject = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.subject;
  if (subject === undefined) return null;
  if (subject.kind === "star") return <StarTray />;
  return <ThreadTray key={JSON.stringify(subject)} subject={subject} />;
}

function StarTray() {
  const rows = useSyncExternalStore(extensionRows.subscribe, extensionRows.get);
  const details = useStarDetails();
  const subject = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.subject;
  if (details === null) return null;
  const schedules = drawnHome(details.star)?.schedules ?? [];
  const shelf = (name: DetailsShelfName): { readonly holds: boolean; readonly count: number } => {
    switch (name) {
      case "asks": {
        const count = starRows(rows, details.star.id).length;
        return { holds: count > 0, count };
      }
      case "channels":
        return {
          holds: details.rows.channels.length > 0,
          count: details.rows.channels.filter((row) => row.thread !== null).length,
        };
      case "channel":
        return { holds: subject?.kind === "star" && subject.channel !== null, count: 0 };
      case "settings":
        return { holds: true, count: 0 };
      case "schedules":
        return {
          holds: schedules.length > 0,
          count: schedules.filter((schedule) => schedule.kind === "once").length,
        };
      default:
        return { holds: false, count: 0 };
    }
  };
  return <TrayIcons shelves={STAR_SHELVES} shelf={shelf} />;
}

function ThreadTray({ subject }: { subject: ThreadSubject }) {
  const details = useThreadDetails(subject);
  return <TrayIcons shelves={THREAD_SHELVES} shelf={(name) => threadShelf(details, name)} />;
}

function TrayIcons({
  shelves,
  shelf,
}: {
  shelves: ReadonlyArray<DetailsShelfName>;
  shelf: (name: DetailsShelfName) => { readonly holds: boolean; readonly count: number };
}) {
  const closed = closedShelves(useSyncExternalStore(shelfOrder.subscribe, shelfOrder.get)).filter(
    (name) => shelves.includes(name),
  );
  const dragging = useSyncExternalStore(shelfDrag.subscribe, shelfDrag.get) !== null;
  if (closed.length === 0 && !dragging) return null;
  return (
    <div
      className={`pult-panel-tabs pult-tray-shelves${dragging ? " pult-tray-shelves-dropping" : ""}`}
      aria-label="Closed details shelves"
      {...shelfDropHandlers("tray")}
    >
      {closed.map((name) => {
        const { label, icon } = DETAILS_SHELF_ICONS[name];
        const { holds, count } = shelf(name);
        return (
          <button
            key={name}
            type="button"
            data-shelf={name}
            {...shelfDragHandlers(name)}
            onContextMenu={trayMenu(name)}
            title={label}
            aria-label={`Open the ${label} shelf`}
            className={`pult-panel-tab${holds ? "" : " pult-tray-shelf-empty"}`}
            onClick={() => openShelf(name)}
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
