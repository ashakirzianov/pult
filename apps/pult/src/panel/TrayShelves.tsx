import { useSyncExternalStore } from "react";

import { limitsShelf } from "../limits/limits.ts";
import { limitsStore } from "../limits/model.ts";
import { onDidSelectThread, openExplorerFiles } from "../threads/selection.ts";
import { type ShelfName, threadStore } from "../threads/store.ts";
import { openExplorerShelf, showThreads } from "./explorer.ts";
import { selectedCardKey, selectionSnapshot } from "./jump.ts";
import { CLOSABLE_SHELVES, type ClosableShelf, keyOf } from "./order.ts";
import { useMinuteClock } from "./PanelView.tsx";
import { closedShelves, openShelf } from "./shelves.tsx";

const ICONS: Record<ClosableShelf, { readonly label: string; readonly icon: string }> = {
  explorer: { label: "Explorer", icon: "files" },
  working: { label: "Working", icon: "pulse" },
  snoozed: { label: "Snoozed", icon: "bell-slash" },
  settled: { label: "Settled", icon: "check" },
  limits: { label: "Limits", icon: "dashboard" },
};

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
 * The closed shelves' icons in the tray, beside the gear, in the panel's
 * order (`CLOSABLE_SHELVES`); a click opens the shelf on the Pult tab and
 * brings it into view, the Explorer shelf's the Explorer tab with it,
 * provisionally (`openExplorerShelf`). Each carries its shelf's count as a badge in the
 * accent colour, as Source Control's tab does, but Settled, whose count is in
 * its tooltip, and Limits, whose badge is the count of warning windows, none
 * while nothing warns; dimmed with no badge while the shelf holds nothing;
 * highlighted as the open tab is while the shelf holds the selected card, the
 * Explorer shelf while the Explorer workspace is selected.
 */
export function TrayShelves() {
  const closed = useSyncExternalStore(closedShelves.subscribe, closedShelves.get);
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const { files } = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  const limits = useSyncExternalStore(limitsStore.subscribe, limitsStore.get);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  if (closed.size === 0) return null;
  // Read on the selection's change, which re-renders the tray.
  const selectedCard = selectedCardKey();
  const on = (shelf: ShelfName) => state.threads.filter((thread) => thread.shelf === shelf);
  const holdsSelected = (shelf: ShelfName) =>
    on(shelf).some((thread) => keyOf(thread) === selectedCard);
  const icon = (shelf: ClosableShelf): ShelfIcon => {
    const { label } = ICONS[shelf];
    switch (shelf) {
      case "explorer":
        return {
          badge: undefined,
          empty: state.environments.length === 0 && files.length === 0,
          selected: selection === "explorer",
          title: label,
        };
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
        const shelfShown = limitsShelf(limits.accounts, now, false);
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
    <div className="pult-panel-tabs pult-tray-shelves" aria-label="Closed shelves">
      {CLOSABLE_SHELVES.filter((shelf) => closed.has(shelf)).map((shelf) => {
        const { badge, empty, selected, title } = icon(shelf);
        return (
          <button
            key={shelf}
            type="button"
            title={title}
            aria-label={`Open the ${ICONS[shelf].label} shelf`}
            className={`pult-panel-tab${selected ? " pult-panel-tab-active" : ""}${empty ? " pult-tray-shelf-empty" : ""}`}
            onClick={() =>
              void (shelf === "explorer"
                ? openExplorerShelf()
                : showThreads().then(() => openShelf(shelf)))
            }
          >
            <i className={`codicon codicon-${ICONS[shelf].icon}`} aria-hidden />
            {badge === undefined ? null : <span className="pult-panel-tab-badge">{badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
