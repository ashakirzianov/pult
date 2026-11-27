import { useRef } from "react";

import { createShelves, readShelfOrder, ShelfHeaderFrame } from "../panel/shelves.tsx";

const SHELVES_KEY = "pult-shell.details.shelf-order";

/**
 * The right panel's shelves, a Star's and a thread's in one default order;
 * Asks and Schedules are one shelf each for both (`pult/decisions`,
 * `view-right-panel`).
 */
const DETAILS_SHELVES = [
  "asks",
  "channels",
  "channel",
  "thread",
  "changes",
  "actions",
  "servers",
  "subagents",
  "sideChats",
  "schedules",
  "settings",
] as const;

export type DetailsShelfName = (typeof DETAILS_SHELVES)[number];

/** The shelves a Star's details show. */
export const STAR_SHELVES: ReadonlyArray<DetailsShelfName> = [
  "asks",
  "channels",
  "channel",
  "schedules",
  "settings",
];

/** The shelves a thread's or a draft's details show. */
export const THREAD_SHELVES: ReadonlyArray<DetailsShelfName> = [
  "asks",
  "thread",
  "changes",
  "actions",
  "servers",
  "subagents",
  "sideChats",
  "schedules",
];

/** Each shelf's label and codicon, its header's and its tray icon's (`DetailsTray.tsx`). */
export const DETAILS_SHELF_ICONS: Record<
  DetailsShelfName,
  { readonly label: string; readonly icon: string }
> = {
  asks: { label: "Asks", icon: "comment-unresolved" },
  channels: { label: "Channels", icon: "comment-discussion" },
  channel: { label: "Channel", icon: "info" },
  thread: { label: "Thread", icon: "info" },
  changes: { label: "Changes", icon: "source-control" },
  actions: { label: "Actions", icon: "play" },
  servers: { label: "Servers", icon: "server-process" },
  subagents: { label: "Subagents", icon: "hubot" },
  sideChats: { label: "Side chats", icon: "comment-discussion" },
  schedules: { label: "Schedules", icon: "calendar" },
  settings: { label: "Star Settings", icon: "settings" },
};

/** The right panel's shelves, one order for every subject, as the left panel's (`createShelves`). */
export const detailsShelves = createShelves(
  SHELVES_KEY,
  readShelfOrder(SHELVES_KEY, DETAILS_SHELVES, { top: DETAILS_SHELVES, bottom: [], closed: [] }),
);

/** An open shelf of the right panel: its header, with `status` before its Close and `onOpen` its click, over its rows. */
export function DetailsShelf({
  name,
  status = null,
  className = "",
  onOpen,
  openTitle,
  children,
}: {
  name: DetailsShelfName;
  status?: React.ReactNode;
  className?: string;
  onOpen?: () => void;
  openTitle?: string;
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
        onOpen={onOpen}
        openTitle={openTitle}
      />
      {children}
    </li>
  );
}
