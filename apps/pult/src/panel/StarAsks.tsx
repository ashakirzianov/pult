import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { renderMarkdown } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/markdownRenderer";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { IOpenerService } from "@codingame/monaco-vscode-api/vscode/vs/platform/opener/common/opener.service";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { toUriPath } from "../files/paths.ts";
import { pultResource } from "../files/workspace.ts";
import type { RouteAsk } from "../stars/plugin.ts";
import { drawnHome, type Star, type StarHome, starName } from "../stars/stars.ts";
import { selectedStar } from "../threads/selection.ts";
import { askExpansion, closeAsk, toggleAsk } from "./asks.ts";
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
 * state and never dimmed; a click reveals the Star's first ask in Inbox
 * (`pult-shell.openStarAsk`). None at zero.
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

/** Reply and Open Source, the row's right-click, as its expansion's buttons run them. */
async function showAskMenu(star: Star, ask: RouteAsk, anchor: { x: number; y: number }) {
  (await getService(IContextMenuService)).showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      toAction({
        id: "pult-shell.replyToStarAsk",
        label: "Reply",
        run: () => run("pult-shell.replyToStarAsk", star.id, ask.name),
      }),
      toAction({
        id: "pult-shell.openStarAskSource",
        label: "Open Source",
        run: () => run("pult-shell.openStarAskSource", star.id, ask.name),
      }),
    ],
  });
}

/**
 * An ask's row in Inbox (xaxis `pult/issues/star-asks-list.md`), in a
 * card's look: "<Star> · Ask" with its environment's chip while there are
 * several, over its title, highlighted while expanded and its Star selected.
 * A click selects the Star and expands the row, one at a time, a cancelled
 * switch expanding nothing, or closes it again (`asks.ts`); expanded, the ask's whole
 * Markdown (`AskText`), "No text available" for an empty one, then Reply,
 * which cites it into the Star's composer (`pult-shell.replyToStarAsk`), and
 * Open Source, its file as a tab (`pult-shell.openStarAskSource`); Escape
 * closes it from inside. Its right-click is the same two. Nothing here
 * answers or removes an ask: the Star deletes its file.
 */
export function AskRow({
  star,
  home,
  ask,
  environment,
  selected,
}: {
  star: Star;
  home: StarHome;
  ask: RouteAsk;
  environment: string | undefined;
  /** Whether the Star is the selection. */
  selected: boolean;
}) {
  const key = askKey({ starId: star.id, name: ask.name });
  const { key: expandedKey, revealed } = useSyncExternalStore(
    askExpansion.subscribe,
    askExpansion.get,
  );
  const expanded = expandedKey === key;
  const element = useRef<HTMLLIElement>(null);
  const select = useRef<HTMLDivElement>(null);
  // A reveal of this row brings it into view, once for each.
  useEffect(() => {
    if (expanded && revealed > 0)
      element.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [expanded, revealed]);
  const open = () => {
    if (expanded) return closeAsk();
    void getService(ICommandService)
      .then((commands) => commands.executeCommand("pult-shell.selectStar", star.id))
      // A switch cancelled over a modified file leaves the selection as it was, and the row closed.
      .then(() => {
        if (selectedStar() === star.id) toggleAsk({ starId: star.id, name: ask.name });
      });
  };
  return (
    <li
      ref={element}
      className={`pult-card pult-card-ask${expanded && selected ? " pult-card-selected" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.stopPropagation();
        closeAsk();
        select.current?.focus();
      }}
    >
      <div
        ref={select}
        role="button"
        tabIndex={0}
        className="pult-card-select"
        title={ask.title}
        aria-expanded={expanded}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          open();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showAskMenu(star, ask, { x: event.clientX, y: event.clientY });
        }}
      >
        <span className="pult-card-top">
          <i className="codicon codicon-comment-unresolved pult-card-icon" aria-hidden />
          <span className="pult-card-project">{starName(star)} · Ask</span>
          <EnvironmentChip label={environment} />
        </span>
        <span className="pult-card-title">{ask.title}</span>
        <JumpHint rowKey={key} />
      </div>
      {expanded ? (
        <div className="pult-card-details pult-ask-details">
          {ask.text.trim() === "" ? (
            <p className="pult-ask-empty">No text available</p>
          ) : (
            <AskText home={home} text={ask.text} />
          )}
          <div className="pult-ask-actions">
            <button
              type="button"
              className="pult-panel-button"
              onClick={() => run("pult-shell.replyToStarAsk", star.id, ask.name)}
            >
              Reply
            </button>
            <button
              type="button"
              className="pult-panel-button"
              onClick={() => run("pult-shell.openStarAskSource", star.id, ask.name)}
            >
              Open Source
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * An ask's Markdown through the workbench's renderer, sanitised as the
 * workbench's hovers are: a relative link resolves under the Star's folder
 * on the home, a `pult:` file the opener shows as a tab, and a web link
 * opens in the browser, both through the workbench's opener.
 */
function AskText({ home, text }: { home: StarHome; text: string }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = element.current;
    if (target === null) return;
    const folder = pultResource(home.environmentId, `${toUriPath(home.root)}/`);
    const rendered = renderMarkdown(
      { value: text, baseUri: folder },
      {
        actionHandler: (link) =>
          void getService(IOpenerService).then((opener) =>
            opener.open(URI.parse(link), { fromUserGesture: true }),
          ),
        sanitizerConfig: { allowedLinkSchemes: { augment: [folder.scheme] } },
      },
    );
    target.replaceChildren(rendered.element);
    return () => rendered.dispose();
  }, [home.environmentId, home.root, text]);
  return <div ref={element} className="pult-ask-text" />;
}
