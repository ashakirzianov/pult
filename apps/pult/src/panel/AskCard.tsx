import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useState, useSyncExternalStore } from "react";

import type { PageAsk } from "../asks/asks.ts";
import { posterName } from "../asks/asks.ts";
import { actOnPageAsk, askStore } from "../asks/model.ts";
import { starMarks, starStillUrl } from "../stars/mark.ts";
import { starById, starStore } from "../stars/model.ts";
import { type Star, starName } from "../stars/stars.ts";
import { showSnoozePresets } from "../threads/park.ts";
import { projectIconUri, threadProjectIcon, useProjectIcons } from "../threads/projectIcon.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";
import { askKey } from "./order.ts";
import { age } from "./PanelView.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/**
 * A Star's posted asks' count after its name on the card, across the
 * environments: the number alone, the titles its tooltip, one per line, the
 * same in every state and never dimmed; a click opens its first ask as its
 * row does (`pult-shell.openAsk`). None at zero.
 */
export function StarAsksBadge({ star }: { star: Star }) {
  const asks = useSyncExternalStore(askStore.subscribe, askStore.get).filter(
    (ask) => ask.status === "posted" && "star" in ask.poster && ask.poster.star === star.id,
  );
  const first = asks[0];
  if (first === undefined) return null;
  return (
    <span
      className="pult-star-asks-badge"
      title={asks.map((ask) => ask.title).join("\n")}
      aria-label={`${asks.length} ${asks.length === 1 ? "ask" : "asks"}`}
      onClick={(event) => {
        // The card's own click would select the Star alone.
        event.stopPropagation();
        run("pult-shell.openAsk", first.environmentId, first.id);
      }}
    >
      {asks.length}
    </span>
  );
}

/** When a snoozed ask comes back: its time today, else its day and time. */
function untilLabel(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now).toDateString() === at.toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return today
    ? time
    : `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** The ask's status where a thread's sits: a speech bubble posted, a reply's mark replied, each with its age; the time a snooze ends; a settle's check with its age. */
function AskStatus({ ask, now }: { ask: PageAsk; now: number }) {
  switch (ask.status) {
    case "posted":
      return (
        <span className="pult-card-status" title="Ask">
          <i className="codicon codicon-comment-unresolved" aria-label="Ask" />{" "}
          {age(ask.posted, now)}
        </span>
      );
    case "replied":
      return (
        <span className="pult-card-status" title="Replied">
          <i className="codicon codicon-comment" aria-label="Replied" />{" "}
          {age(ask.replied ?? ask.posted, now)}
        </span>
      );
    case "snoozed":
      return (
        <span className="pult-card-status" title="Snoozed">
          <i className="codicon codicon-bell-slash" aria-hidden />{" "}
          {ask.snoozedUntil === null ? "Snoozed" : untilLabel(ask.snoozedUntil, now)}
        </span>
      );
    case "settled":
      return (
        <span className="pult-card-status">
          <i className="codicon codicon-check" aria-hidden /> {age(ask.settled ?? ask.posted, now)}
        </span>
      );
  }
}

/** The ask's status, and its actions in its place on hover, a thread card's: Snooze and Settle while posted or replied, Wake while snoozed, Un-settle while settled. */
function AskSlot({ ask, now }: { ask: PageAsk; now: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const open = ask.status === "posted" || ask.status === "replied";
  return (
    <span className={`pult-card-slot${menuOpen ? " pult-card-slot-open" : ""}`}>
      <AskStatus ask={ask} now={now} />
      {/* Clicks stop here, short of the row that opens the ask. */}
      <span className="pult-card-actions" onClick={(event) => event.stopPropagation()}>
        {open ? (
          <button
            type="button"
            title="Snooze"
            aria-label="Snooze ask"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              setMenuOpen(true);
              void showSnoozePresets(
                event.currentTarget,
                () => setMenuOpen(false),
                (until) => void actOnPageAsk(ask, { kind: "snooze", until }),
              );
            }}
          >
            <i className="codicon codicon-clock" aria-hidden />
          </button>
        ) : null}
        {open ? (
          <button
            type="button"
            title="Settle ask"
            onClick={() => void actOnPageAsk(ask, { kind: "settle" })}
          >
            <i className="codicon codicon-check" aria-hidden />
            Settle
          </button>
        ) : null}
        {ask.status === "snoozed" ? (
          <button
            type="button"
            title="Wake ask"
            aria-label="Wake ask"
            onClick={() => void actOnPageAsk(ask, { kind: "snooze", until: null })}
          >
            <i className="codicon codicon-bell" aria-hidden />
          </button>
        ) : null}
        {ask.status === "settled" ? (
          <button
            type="button"
            title="Un-settle ask"
            aria-label="Un-settle ask"
            onClick={() => void actOnPageAsk(ask, { kind: "unsettle" })}
          >
            <i className="codicon codicon-discard" aria-hidden />
          </button>
        ) : null}
      </span>
    </span>
  );
}

/** The poster's icon in the project's place: a Star's mark as its tab shows it, a thread's project's icon. */
function PosterIcon({ star, thread }: { star: Star | undefined; thread: ShellThread | undefined }) {
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  useProjectIcons();
  if (star !== undefined)
    return <img className="pult-card-icon" src={starStillUrl(star, marks)} alt="" />;
  if (thread !== undefined)
    return (
      <img
        className="pult-card-icon"
        src={projectIconUri(threadProjectIcon(thread)).toString(true)}
        alt=""
      />
    );
  return <i className="codicon codicon-comment-discussion pult-card-icon" aria-hidden />;
}

/**
 * An ask's row (Beta's `designs/ask-model.md`), on the shelf its status
 * puts it on: a thread card's look with its poster in the project's place,
 * a Star's mark and name with its channel but `user`'s, or the posting
 * thread's project icon and title, its environment's chip while there are
 * several, its status where a thread's sits, giving way on hover to a
 * thread card's Snooze, Wake, Settle or Un-settle, and its title. A click
 * opens its file among its poster's tabs with the poster's composer under
 * it, a reply (`pult-shell.openAsk`).
 */
export function AskCard({
  ask,
  environment,
  now,
}: {
  ask: PageAsk;
  environment: string | undefined;
  now: number;
}) {
  useSyncExternalStore(starStore.subscribe, starStore.get);
  const { threads } = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const star = "star" in ask.poster ? starById(ask.poster.star) : undefined;
  const thread =
    "thread" in ask.poster
      ? threads.find(
          (each) =>
            each.environmentId === ask.environmentId &&
            "thread" in ask.poster &&
            each.id === ask.poster.thread,
        )
      : undefined;
  const name = posterName(
    ask,
    (starId) => {
      const found = starById(starId);
      return found === undefined ? undefined : starName(found);
    },
    () => thread?.title,
  );
  const open = () => run("pult-shell.openAsk", ask.environmentId, ask.id);
  return (
    <li className={`pult-card${ask.status === "settled" ? " pult-card-settled" : ""}`}>
      {/* A button by role, as a thread's card: its actions are buttons inside it. */}
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        title={ask.title}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          open();
        }}
      >
        <span className="pult-card-top">
          <PosterIcon star={star} thread={thread} />
          <span className="pult-card-project">{name}</span>
          <EnvironmentChip label={environment} />
          <AskSlot ask={ask} now={now} />
        </span>
        <span className="pult-card-title">{ask.title}</span>
        <JumpHint rowKey={askKey(ask)} />
      </div>
    </li>
  );
}
