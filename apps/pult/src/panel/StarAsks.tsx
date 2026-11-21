import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import { starMarks, starStillUrl } from "../stars/mark.ts";
import type { RouteAsk } from "../stars/plugin.ts";
import { drawnHome, type Star, starName } from "../stars/stars.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";
import { askKey } from "./order.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * A Star's asks' count after its name on the card (xaxis
 * `pult/issues/star-asks-list.md`), those of the home it is drawn from: the
 * number alone, the titles its tooltip, one per line, the same in every
 * state and never dimmed; a click opens the Star's first ask as its card
 * does (`pult-shell.openStarAsk`). None at zero.
 */
export function StarAsksBadge({ star }: { star: Star }) {
  const asks = drawnHome(star)?.asks ?? [];
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
        run("pult-shell.openStarAsk", star.id, first.name);
      }}
    >
      {asks.length}
    </span>
  );
}

/**
 * An ask's card in Inbox (xaxis `pult/issues/star-asks-list.md`), a thread
 * card's look with its author where a thread's project sits: the Star's
 * mark, as its tab shows it (`starStillUrl`), and its name, its
 * environment's chip while there are several, a speech bubble where a
 * thread's status sits, as a draft's pen sits there, and the ask's title,
 * its file's first line. Nothing more: a click opens the ask's file among
 * the Star's tabs with the composer under it (`pult-shell.openStarAsk`), so
 * a citation goes to the Star. Nothing here answers or removes an ask: the
 * Star deletes its file.
 */
export function AskCard({
  star,
  ask,
  environment,
}: {
  star: Star;
  ask: RouteAsk;
  environment: string | undefined;
}) {
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  return (
    <li className="pult-card">
      <button
        type="button"
        className="pult-card-select"
        title={ask.title}
        onClick={() => run("pult-shell.openStarAsk", star.id, ask.name)}
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={starStillUrl(star, marks)} alt="" />
          <span className="pult-card-project">{starName(star)}</span>
          <EnvironmentChip label={environment} />
          <span className="pult-card-status">
            <i className="codicon codicon-comment-unresolved" title="Ask" aria-label="Ask" />
          </span>
        </span>
        <span className="pult-card-title">{ask.title}</span>
        <JumpHint rowKey={askKey({ starId: star.id, name: ask.name })} />
      </button>
    </li>
  );
}
