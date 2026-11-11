import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { drawnHome, type Star } from "../stars/stars.ts";
import { CollapsibleHeader, useExpanded } from "./collapsible.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * A Star's asks' count after its name on the card (xaxis
 * `pult/issues/star-asks.md`), those of the home it is drawn from: the
 * number alone, the titles its tooltip, one per line, the same in every
 * state and never dimmed. None at zero.
 */
export function StarAsksBadge({ star }: { star: Star }) {
  const asks = drawnHome(star)?.asks ?? [];
  if (asks.length === 0) return null;
  return (
    <span
      className="pult-star-asks-badge"
      title={asks.map((ask) => ask.title).join("\n")}
      aria-label={`${asks.length} ${asks.length === 1 ? "ask" : "asks"}`}
    >
      {asks.length}
    </span>
  );
}

/**
 * A selected Star's asks on its card, those of the home it is drawn from,
 * as that home's plugin serves them on its `stars` route: under a
 * collapsible "Asks" with their count, a row per ask with its title, in the
 * subagents' look; a click opens its file as a tab among the Star's with
 * the Star's composer under it (`pult-shell.openStarAsk`). Hidden with none.
 */
export function StarAsks({ star }: { star: Star }) {
  const asks = drawnHome(star)?.asks ?? [];
  const [expanded, setExpanded] = useExpanded("pult-shell.panel.asks-expanded", true);
  if (asks.length === 0) return null;
  return (
    <div className="pult-card-asks">
      <CollapsibleHeader
        label="Asks"
        count={asks.length}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <ul className="pult-subagents-list" aria-label="Asks">
          {asks.map((ask) => (
            <li key={ask.name}>
              <button
                type="button"
                className="pult-subagent"
                title={ask.path}
                onClick={() => run("pult-shell.openStarAsk", star.id, ask.name)}
              >
                <i className="codicon codicon-comment-unresolved" aria-hidden />
                <span className="pult-subagent-title">{ask.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
