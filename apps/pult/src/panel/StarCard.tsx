import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";

import { starMarkUrl } from "../stars/mark.ts";
import { asleepSince, type Star, starName } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";
import { starKey } from "./order.ts";
import { type Activity, age, Elapsed, Subagents } from "./PanelView.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** The card's context menu: Edit Star Instructions and Open Star Folder; a Star has no New Conversation, writing to it wakes it. */
async function showStarMenu(star: Star, anchor: { x: number; y: number }): Promise<void> {
  const menus = await getService(IContextMenuService);
  menus.showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      toAction({
        id: "pult-shell.editStarInstructions",
        label: "Edit Star Instructions",
        run: () => run("pult-shell.editStarInstructions", star.id),
      }),
      toAction({
        id: "pult-shell.openStarFolder",
        label: "Open Star Folder",
        run: () => run("pult-shell.openStarFolder", star.id),
      }),
    ],
  });
}

/**
 * A Star's card, the panel's first row, under no header (`star-card`): its
 * mark, its name ("Star" while it has none), its environment's chip while
 * the page holds several, and its state, Asleep with how long (dimmed),
 * Awake, or Working with its elapsed time. A click selects the Star
 * (`pult-shell.selectStar`), a right-click opens its menu. Selected, it
 * expands with its current conversation's subagents, as a thread's card
 * does with its own.
 */
export function StarCard({
  star,
  environment,
  subagents,
  activities,
  selected,
  selection,
  now,
}: {
  star: Star;
  environment: string | undefined;
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  selected: boolean;
  selection: string | undefined;
  now: number;
}) {
  const select = () => run("pult-shell.selectStar", star.id);
  return (
    <li className={`pult-card pult-card-star${selected ? " pult-card-selected" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={select}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          select();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showStarMenu(star, { x: event.clientX, y: event.clientY });
        }}
      >
        <span className="pult-star-row">
          <img className="pult-star-mark" src={starMarkUrl(star.tint)} alt="" />
          <span className="pult-star-name">{starName(star)}</span>
          <EnvironmentChip label={environment} />
          <StarStatus star={star} now={now} />
        </span>
        <JumpHint rowKey={starKey(star.id)} />
      </div>
      {selected && subagents.length > 0 ? (
        <div className="pult-card-details">
          <Subagents
            subagents={subagents}
            activities={activities}
            selection={selection}
            now={now}
          />
        </div>
      ) : null}
    </li>
  );
}

function StarStatus({ star, now }: { star: Star; now: number }) {
  if (star.state === "working") {
    return (
      <span className="pult-card-status pult-card-status-working">
        Working
        {star.current?.workingSince == null ? null : <Elapsed since={star.current.workingSince} />}
      </span>
    );
  }
  if (star.state === "awake")
    return <span className="pult-card-status pult-star-awake">Awake</span>;
  const since = age(asleepSince(star), now);
  return (
    <span className="pult-card-status pult-star-asleep">
      Asleep{since === "" ? "" : ` · ${since}`}
    </span>
  );
}
