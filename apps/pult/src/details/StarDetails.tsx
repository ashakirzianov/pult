import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { limitsStore } from "../limits/model.ts";
import { useSyncExternalStore } from "react";

import { askStore } from "../asks/model.ts";
import { keyOf, openShelves } from "../panel/order.ts";
import { type Activity, age, Status } from "../panel/PanelView.tsx";
import { StarSchedules } from "../panel/StarSchedules.tsx";
import { starLook } from "../stars/look.ts";
import { lookStillUrl, starMarks } from "../stars/mark.ts";
import { canSleepChannel } from "../stars/model.ts";
import { type CardRows, type Star, workingChannels } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";
import { hasUsageProviderIcon, UsageProviderIcon } from "../../view/usageProviders.tsx";
import { detailsCards } from "./cards.ts";
import { ChannelDetails } from "./ChannelDetails.tsx";
import { StarSettings } from "./StarSettings.tsx";
import { DetailsShelf, type DetailsShelfName, detailsShelves } from "./shelves.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * A selected Star's details (`pult/decisions`, `star-card`,
 * `view-right-panel`): its shelves, in their order (`detailsShelves`), each
 * closing into the tray and left out while it holds nothing: its posted asks
 * (`StarAsks`), its channels with their threads (`StarChannels`), the
 * selected channel's details (`ChannelDetails.tsx`), its schedules
 * (`StarSchedules.tsx`), and its settings (`StarSettings`).
 */
export function StarDetails({
  star,
  rows,
  subagentsOf,
  threads,
  activities,
  now,
}: {
  star: Star;
  /** Its channels' rows, as the page's threads have them (`cardRows`). */
  rows: CardRows<ShellThread>;
  /** The subagents under each conversation, by its key. */
  subagentsOf: ReadonlyMap<string, ReadonlyArray<ShellThread>>;
  /** The store's live rows, which a channel's look is read from. */
  threads: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  now: number;
}) {
  const order = useSyncExternalStore(
    detailsShelves.shelfOrder.subscribe,
    detailsShelves.shelfOrder.get,
  );
  const dragging =
    useSyncExternalStore(detailsShelves.shelfDrag.subscribe, detailsShelves.shelfDrag.get) !== null;
  const shelf = (name: DetailsShelfName): React.ReactNode => {
    switch (name) {
      case "asks":
        return <StarAsks key={name} star={star} now={now} />;
      case "channels":
        return (
          <StarChannels
            key={name}
            star={star}
            rows={rows}
            subagentsOf={subagentsOf}
            threads={threads}
            activities={activities}
            now={now}
          />
        );
      case "channel":
        return <ChannelDetails key={name} star={star} rows={rows} now={now} />;
      case "settings":
        return <StarSettings key={name} star={star} />;
      case "schedules":
        return <StarSchedules key={name} star={star} now={now} />;
    }
  };
  return (
    <ul
      className={`pult-details-shelves${dragging ? " pult-shelf-dragging" : ""}`}
      {...detailsShelves.shelfDropHandlers("open")}
    >
      {[
        ...openShelves(order, "top").map(shelf),
        <li key="gap" className="pult-shelf-gap" aria-hidden />,
        ...openShelves(order, "bottom").map(shelf),
      ]}
      <detailsShelves.ShelfDropLine place="open" />
    </ul>
  );
}

/** A thread's icon under its channel: its provider's logo, the generic agent's for a provider the page has no logo of. */
function ThreadIcon({ thread }: { thread: ShellThread }) {
  const driver = useSyncExternalStore(limitsStore.subscribe, () =>
    limitsStore.providerDriver(thread.environmentId, thread.providerInstanceId),
  );
  return driver !== undefined && hasUsageProviderIcon(driver) ? (
    <span className="pult-thread-provider" aria-hidden>
      <UsageProviderIcon driver={driver} />
    </span>
  ) : (
    <i className="codicon codicon-hubot" aria-hidden />
  );
}

/** The threads under a channel, the ones it launched and its conversation's subagents, each opening as a thread's tab among the Star's (`pult-shell.openStarChild`). */
function ChannelThreads({
  starId,
  threads,
  activities,
  now,
}: {
  starId: string;
  threads: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  now: number;
}) {
  return threads.map((child) => (
    <li key={keyOf(child)}>
      <button
        type="button"
        className="pult-subagent"
        title={child.title}
        onClick={() => run("pult-shell.openStarChild", starId, child.environmentId, child.id)}
      >
        <ThreadIcon thread={child} />
        <span className="pult-subagent-title">{child.title}</span>
        <Status thread={child} activity={activities.get(keyOf(child)) ?? null} now={now} />
      </button>
    </li>
  ));
}

/** A Star's posted asks, across its environments. */
export function starAsks<Ask extends { status: string; poster: object }>(
  asks: ReadonlyArray<Ask>,
  starId: string,
): Ask[] {
  return asks.filter(
    (ask) => ask.status === "posted" && "star" in ask.poster && ask.poster.star === starId,
  );
}

/**
 * A Star's posted asks on their shelf: a row each in the subagents' look, its
 * title and its age, opening it as its Inbox row does (`pult-shell.openAsk`).
 * Hidden with none.
 */
function StarAsks({ star, now }: { star: Star; now: number }) {
  const asks = starAsks(useSyncExternalStore(askStore.subscribe, askStore.get), star.id);
  if (asks.length === 0) return null;
  return (
    <DetailsShelf name="asks">
      <ul className="pult-subagents-list" aria-label="Asks">
        {asks.map((ask) => (
          <li key={`${ask.environmentId}:${ask.id}`}>
            <button
              type="button"
              className="pult-subagent"
              title={ask.title}
              onClick={() => run("pult-shell.openAsk", ask.environmentId, ask.id)}
            >
              <i className="codicon codicon-comment-unresolved" aria-hidden />
              <span className="pult-subagent-title">{ask.title}</span>
              <span className="pult-card-status">{age(ask.posted, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </DetailsShelf>
  );
}

/** A channel's row's icon: the Star's mark, still, in the look its conversation alone would give the Star, asleep without one, with its own planet while it works (`workingChannels`). */
function ChannelMark({
  star,
  thread,
  works,
  threads,
}: {
  star: Star;
  thread: ShellThread | null;
  works: boolean;
  threads: ReadonlyArray<ShellThread>;
}) {
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  const look = thread === null ? "asleep" : starLook({ channels: [{ thread }] }, threads);
  return (
    <img
      className="pult-channel-mark"
      src={lookStillUrl(star.tint, look, works ? 1 : 0, marks)}
      alt=""
      draggable={false}
    />
  );
}

/** A channel's row's context menu: Refresh Context, its next message then waking it in a fresh conversation; none while it cannot be put to sleep by hand (`canSleepChannel`). */
async function showChannelMenu(
  star: Star,
  slug: string,
  anchor: { x: number; y: number },
): Promise<void> {
  if (!canSleepChannel(star, slug)) return;
  (await getService(IContextMenuService)).showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      toAction({
        id: "pult-shell.refreshContext",
        label: "Refresh Context",
        run: () => run("pult-shell.refreshContext", star.id, slug),
      }),
    ],
  });
}

/**
 * A selected Star's channels on their shelf, the default channel first: a
 * row each, the Star's mark in that channel's look, its slug and its status,
 * Working with its elapsed time, Waiting, the time since its last turn, or
 * Asleep, over the threads it launched and its conversation's subagents
 * (`ChannelThreads`). The default channel's row selects the Star, whose tab
 * is that channel's, awake or asleep; another open channel's opens its
 * conversation as a thread's tab among the Star's
 * (`pult-shell.openStarChannel`); an asleep channel opens its draft. A row's
 * right-click is its menu (`showChannelMenu`).
 */
function StarChannels({
  star,
  rows,
  subagentsOf,
  threads,
  activities,
  now,
}: {
  star: Star;
  rows: CardRows<ShellThread>;
  subagentsOf: ReadonlyMap<string, ReadonlyArray<ShellThread>>;
  threads: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  now: number;
}) {
  const starId = star.id;
  const subject = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.subject;
  const selected = subject?.kind === "star" ? subject.channel : null;
  const working = workingChannels(rows, threads);
  return (
    <DetailsShelf name="channels">
      <ul className="pult-subagents-list" aria-label="Channels">
        {rows.channels.map(({ slug, thread, children }) => {
          const below = [
            ...children,
            ...(thread === null ? [] : (subagentsOf.get(keyOf(thread)) ?? [])),
          ];
          const content = (
            <>
              <ChannelMark
                star={star}
                thread={thread}
                works={working.has(slug)}
                threads={threads}
              />
              <span className="pult-subagent-title">{slug}</span>
              {thread === null ? (
                <span className="pult-card-status pult-star-asleep">Asleep</span>
              ) : (
                <Status
                  thread={thread}
                  activity={activities.get(keyOf(thread)) ?? null}
                  now={now}
                />
              )}
            </>
          );
          const open =
            slug === star.defaultChannel
              ? () => run("pult-shell.selectStar", starId)
              : () => run("pult-shell.openStarChannel", starId, slug);
          return (
            <li key={`channel:${slug}`}>
              <button
                type="button"
                aria-current={slug === selected ? "true" : undefined}
                className={
                  slug === selected ? "pult-subagent pult-subagent-selected" : "pult-subagent"
                }
                title={`Channel ${slug}`}
                onClick={open}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void showChannelMenu(star, slug, { x: event.clientX, y: event.clientY });
                }}
              >
                {content}
              </button>
              {below.length > 0 ? (
                <ul
                  className="pult-subagents-list pult-card-children"
                  aria-label={`Threads of ${slug}`}
                >
                  <ChannelThreads
                    starId={starId}
                    threads={below}
                    activities={activities}
                    now={now}
                  />
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </DetailsShelf>
  );
}
