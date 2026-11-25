import { useRef } from "react";

import { createShelves, readShelfOrder, ShelfHeaderFrame } from "../panel/shelves.tsx";

const SHELVES_KEY = "pult-shell.details.shelf-order";

/** The right panel's shelves for a Star, in their default order. */
const DETAILS_SHELVES = ["asks", "channels", "channel", "schedules", "settings"] as const;

export type DetailsShelfName = (typeof DETAILS_SHELVES)[number];

/** Each shelf's label and codicon, its header's and its tray icon's (`DetailsTray.tsx`). */
export const DETAILS_SHELF_ICONS: Record<
  DetailsShelfName,
  { readonly label: string; readonly icon: string }
> = {
  asks: { label: "Asks", icon: "comment-unresolved" },
  channels: { label: "Channels", icon: "comment-discussion" },
  channel: { label: "Channel", icon: "info" },
  schedules: { label: "Schedules", icon: "calendar" },
  settings: { label: "Star Settings", icon: "settings" },
};

/** The right panel's shelves, one order for every Star, as the left panel's (`createShelves`). */
export const detailsShelves = createShelves(
  SHELVES_KEY,
  readShelfOrder(SHELVES_KEY, DETAILS_SHELVES, { top: DETAILS_SHELVES, bottom: [], closed: [] }),
);

/** An open shelf of the right panel: its header, with `status` before its Close, over its rows. */
export function DetailsShelf({
  name,
  status = null,
  className = "",
  children,
}: {
  name: DetailsShelfName;
  status?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const element = useRef<HTMLLIElement>(null);
  detailsShelves.useReveal(name, element);
  const { label, icon } = DETAILS_SHELF_ICONS[name];
  return (
    <li ref={element} className={`pult-shelf pult-details-shelf ${className}`} data-shelf={name}>
      <ShelfHeaderFrame
        id={`details.${name}`}
        label={label}
        icon={icon}
        actions={status}
        drag={detailsShelves.shelfDragHandlers(name)}
        stickAction={() => detailsShelves.stickAction(name)}
        onClose={() => detailsShelves.closeShelf(name)}
      />
      {children}
    </li>
  );
}
