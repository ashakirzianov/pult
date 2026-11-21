import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import { askStore } from "../asks/model.ts";
import { CollapsibleHeader, useExpanded } from "../panel/collapsible.tsx";
import { keyOf } from "../panel/order.ts";
import { type Activity, age, Elapsed, Status, Subagents } from "../panel/PanelView.tsx";
import { StarSchedules } from "../panel/StarSchedules.tsx";
import { LOOK_WORDS, type StarLook } from "../stars/look.ts";
import { starLookOf, starMarks } from "../stars/mark.ts";
import { type CardRows, channelThreads, type Star } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * A selected Star's details in the Details column (`pult/decisions`,
 * `star-card`): its look in words with its time, over the environment it
 * is drawn on; its posted asks (`StarAsks`); `user`'s children and a
 * collapsible Channels holding a row per channel but `user`
 * (`StarChannels`); its current conversation's subagents, as a thread's
 * card lists its own; then its schedules (`StarSchedules.tsx`). Each list
 * is left out while empty.
 */
export function StarDetails({
  star,
  environment,
  rows,
  subagents,
  activities,
  selection,
  now,
}: {
  star: Star;
  /** The name of the environment it is drawn on, if the page holds it. */
  environment: string | undefined;
  /** Its children and its channels' rows, as the page's threads have them (`cardRows`). */
  rows: CardRows<ShellThread>;
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  selection: string | undefined;
  now: number;
}) {
  return (
    <div className="pult-details-star">
      <div className="pult-details-state">
        <StarStatus star={star} now={now} />
        {environment === undefined ? null : (
          <span className="pult-details-environment">on {environment}</span>
        )}
      </div>
      <StarAsks star={star} now={now} />
      <StarChannels starId={star.id} rows={rows} activities={activities} now={now} />
      {subagents.length > 0 ? (
        <Subagents subagents={subagents} activities={activities} selection={selection} now={now} />
      ) : null}
      <StarSchedules star={star} now={now} />
    </div>
  );
}

/**
 * A Star's posted asks, across its environments, under a collapsible "Asks"
 * with their count, open until closed: a row each in the subagents' look,
 * its title and its age, opening it as its Inbox row does
 * (`pult-shell.openAsk`). Hidden with none.
 */
function StarAsks({ star, now }: { star: Star; now: number }) {
  const [expanded, setExpanded] = useExpanded("pult-shell.details.asks-expanded", true);
  const asks = useSyncExternalStore(askStore.subscribe, askStore.get).filter(
    (ask) => ask.status === "posted" && "star" in ask.poster && ask.poster.star === star.id,
  );
  if (asks.length === 0) return null;
  return (
    <div className="pult-details-asks">
      <CollapsibleHeader
        label="Asks"
        count={asks.length}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded ? (
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
      ) : null}
    </div>
  );
}

/**
 * A selected Star's children and channels: `user`'s
 * children first, then a collapsible "Channels" with their count, collapsed
 * until opened and remembered per Star, its header reading Waiting while a
 * thread in it waits, else Working with the longest elapsed time while one
 * works; open, a row per channel but `user`, labelled by its slug,
 * each over its own children (`cardRows`), every row in the subagents' look,
 * its status Working with its elapsed time, Waiting, or the time since its
 * last turn. A click on an open channel's row opens its conversation as a
 * thread's tab among the Star's (`pult-shell.openStarChannel`), on a
 * child's the child (`pult-shell.openStarChild`); a sleeping channel's row,
 * there while a child of it is unsettled, reads Asleep and opens nothing.
 * Hidden with none.
 */
function StarChannels({
  starId,
  rows,
  activities,
  now,
}: {
  starId: string;
  rows: CardRows<ShellThread>;
  activities: Map<string, Activity>;
  now: number;
}) {
  const [expanded, setExpanded] = useExpanded(`pult-shell.panel.channels-expanded:${starId}`);
  if (rows.children.length === 0 && rows.channels.length === 0) return null;
  const children = (threads: ReadonlyArray<ShellThread>) =>
    threads.map((child) => (
      <li key={keyOf(child)}>
        <button
          type="button"
          className="pult-subagent"
          title={child.title}
          onClick={() => run("pult-shell.openStarChild", starId, child.environmentId, child.id)}
        >
          <i className="codicon codicon-hubot" aria-hidden />
          <span className="pult-subagent-title">{child.title}</span>
          <Status thread={child} activity={activities.get(keyOf(child)) ?? null} now={now} />
        </button>
      </li>
    ));
  return (
    <div className="pult-card-channels">
      {rows.children.length > 0 ? (
        <ul className="pult-subagents-list" aria-label="Children">
          {children(rows.children)}
        </ul>
      ) : null}
      {rows.channels.length > 0 ? (
        <CollapsibleHeader
          label="Channels"
          count={rows.channels.length}
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          status={<ChannelsStatus threads={channelThreads(rows)} activities={activities} />}
        />
      ) : null}
      {expanded && rows.channels.length > 0 ? (
        <ul className="pult-subagents-list" aria-label="Channels">
          {rows.channels.map(({ slug, thread, children: below }) => (
            <li key={`channel:${slug}`}>
              {thread === null ? (
                <div
                  className="pult-subagent pult-subagent-asleep"
                  title={`Channel ${slug}, asleep`}
                >
                  <i className="codicon codicon-comment-discussion" aria-hidden />
                  <span className="pult-subagent-title">{slug}</span>
                  <span className="pult-card-status pult-star-asleep">Asleep</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="pult-subagent"
                  title={`Channel ${slug}`}
                  onClick={() => run("pult-shell.openStarChannel", starId, slug)}
                >
                  <i className="codicon codicon-comment-discussion" aria-hidden />
                  <span className="pult-subagent-title">{slug}</span>
                  <Status
                    thread={thread}
                    activity={activities.get(keyOf(thread)) ?? null}
                    now={now}
                  />
                </button>
              )}
              {below.length > 0 ? (
                <ul
                  className="pult-subagents-list pult-card-children"
                  aria-label={`Children of ${slug}`}
                >
                  {children(below)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The Channels header's status: Waiting while a thread in it waits, else Working with the longest elapsed time while one works, else none. */
function ChannelsStatus({
  threads,
  activities,
}: {
  threads: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
}) {
  const activity = (thread: ShellThread) => activities.get(keyOf(thread)) ?? null;
  if (threads.some((thread) => activity(thread) === "waiting"))
    return <span className="pult-card-status pult-card-status-waiting">Waiting</span>;
  const working = threads.filter((thread) => activity(thread) === "working");
  if (working.length === 0) return null;
  // The longest elapsed time is the earliest start.
  const since = working
    .flatMap(({ workingSince }) => (workingSince === null ? [] : [workingSince]))
    .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  return (
    <span className="pult-card-status pult-card-status-working">
      Working{since === undefined ? null : <Elapsed since={since} />}
    </span>
  );
}

/** The look's colour on the state line. */
const LOOK_CLASSES: Readonly<Record<StarLook, string>> = {
  troubled: "pult-card-status-failed",
  waiting: "pult-card-status-waiting",
  working: "pult-card-status-working",
  awake: "pult-star-awake",
  asleep: "pult-star-asleep",
};

/** The Star's state line in its details: its look in words (`LOOK_WORDS`), Working with the longest elapsed time of its working conversations, Asleep with how long `user` has slept. */
function StarStatus({ star, now }: { star: Star; now: number }) {
  const look = starLookOf(star, useSyncExternalStore(starMarks.subscribe, starMarks.get));
  // The longest elapsed time is the earliest start.
  const since = star.channels
    .flatMap(({ thread }) =>
      thread.working && thread.workingSince !== null ? [thread.workingSince] : [],
    )
    .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  const asleepFor = age(star.asleepSince, now);
  return (
    <span className={`pult-card-status ${LOOK_CLASSES[look]}`}>
      {LOOK_WORDS[look]}
      {look === "working" && since !== undefined ? <Elapsed since={since} /> : null}
      {look === "asleep" && asleepFor !== "" ? ` · ${asleepFor}` : null}
    </span>
  );
}
