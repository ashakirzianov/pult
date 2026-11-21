import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useState } from "react";

import type { PageAsk } from "../asks/asks.ts";
import { actOnPageAsk } from "../asks/model.ts";
import { showSnoozePresets } from "../threads/park.ts";
import { askKey } from "./order.ts";
import { age } from "./PanelView.tsx";
import { PosterCard } from "./PosterCard.tsx";

export function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
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

/**
 * An ask's row (Beta's `designs/ask-model.md`), on the shelf its status
 * puts it on: a poster's row (`PosterCard.tsx`) with its status, giving way
 * on hover to a thread card's Snooze, Wake, Settle or Un-settle, and its
 * title. A click opens its file among its poster's tabs with the poster's
 * composer under it, a reply (`pult-shell.openAsk`).
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
  return (
    <PosterCard
      environmentId={ask.environmentId}
      poster={ask.poster}
      environment={environment}
      rowKey={askKey(ask)}
      title={ask.title}
      settled={ask.status === "settled"}
      slot={<AskSlot ask={ask} now={now} />}
      onOpen={() => run("pult-shell.openAsk", ask.environmentId, ask.id)}
    />
  );
}
