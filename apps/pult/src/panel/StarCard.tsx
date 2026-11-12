import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { Separator, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { flatStar } from "../stars/flat/star.ts";
import "../stars/flat/star.css";
import type { StarLook } from "../stars/look.ts";
import { starLookOf, starMarks, tintColor } from "../stars/mark.ts";
import { canSleepStar } from "../stars/model.ts";
import { drawnHome, type Star, type StarChannel, starName } from "../stars/stars.ts";
import type { ShellThread } from "../threads/store.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";
import { keyOf, starKey } from "./order.ts";
import { type Activity, age, Elapsed, Status, Subagents } from "./PanelView.tsx";
import { StarAsks, StarAsksBadge } from "./StarAsks.tsx";
import { StarSchedules } from "./StarSchedules.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The card's context menu: Refresh Context while the Star can be put to
 * sleep by hand (`canSleepStar`), its next message then waking it in a
 * fresh conversation, then Edit Star Instructions and Open Star Folder.
 */
async function showStarMenu(star: Star, anchor: { x: number; y: number }): Promise<void> {
  const menus = await getService(IContextMenuService);
  menus.showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      ...(canSleepStar(star)
        ? [
            toAction({
              id: "pult-shell.refreshContext",
              label: "Refresh Context",
              run: () => run("pult-shell.refreshContext", star.id),
            }),
            new Separator(),
          ]
        : []),
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
 * The Star's mark, drawn live (`src/stars/flat/`): the mark's span made once
 * per card, since each holds ids of its own, and a change of look set on its
 * `data-state`, so the halo's motion carries on from where it was. Its colour
 * is the tint's in the theme's scheme, set on the element around it.
 */
function StarMark({ look, color }: { look: StarLook; color: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const mark = element.querySelector(".flat-star");
    if (mark === null) element.innerHTML = flatStar(look);
    else mark.setAttribute("data-state", look);
  }, [look]);
  return <span ref={ref} className="pult-star-mark" style={{ color }} aria-hidden />;
}

/**
 * A Star's card, the panel's first row, under no header (`star-card`): two
 * rows beside its mark (`StarMark`, its look by `look.ts` in `src/stars/`),
 * its name ("Star" while it has none) with its asks' count
 * (`StarAsks.tsx`) and its environment's chip while the page holds several,
 * over its state, Asleep with how long (dimmed), Awake,
 * or Working with its elapsed time. A click selects the Star
 * (`pult-shell.selectStar`), a right-click opens its menu. Selected, it
 * expands with its asks, then a row per open channel but `user`
 * (`StarChannels`), then its current conversation's subagents, as a
 * thread's card does with its own, then its schedules (`StarSchedules.tsx`), each list
 * a section of the details of its own.
 */
export function StarCard({
  star,
  environment,
  channels,
  subagents,
  activities,
  selected,
  selection,
  now,
}: {
  star: Star;
  environment: string | undefined;
  /** Its open channels but `user`, by slug, each with its conversation's live row (`channelRows`). */
  channels: ReadonlyArray<StarChannel>;
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  selected: boolean;
  selection: string | undefined;
  now: number;
}) {
  const select = () => run("pult-shell.selectStar", star.id);
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  const home = drawnHome(star);
  const hasLists = (home?.asks.length ?? 0) > 0 || (home?.schedules.length ?? 0) > 0;
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
          <StarMark look={starLookOf(star, marks)} color={tintColor(star.tint, marks.scheme)} />
          <span className="pult-star-text">
            <span className="pult-star-head">
              <span className="pult-star-name">{starName(star)}</span>
              <StarAsksBadge star={star} />
              <EnvironmentChip label={environment} />
            </span>
            <StarStatus star={star} now={now} />
          </span>
        </span>
        <JumpHint rowKey={starKey(star.id)} />
      </div>
      {selected && (subagents.length > 0 || channels.length > 0 || hasLists) ? (
        <div className="pult-card-details">
          <StarAsks star={star} />
          <StarChannels starId={star.id} channels={channels} activities={activities} now={now} />
          {subagents.length > 0 ? (
            <Subagents
              subagents={subagents}
              activities={activities}
              selection={selection}
              now={now}
            />
          ) : null}
          <StarSchedules star={star} now={now} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * A selected Star's open channels but `user`, under its card: a row each,
 * labelled by its slug, in the subagents' look, its status Working with
 * its elapsed time, Waiting, or the time since its last turn; a click opens
 * its conversation as a thread's tab among the Star's
 * (`pult-shell.openStarChannel`). Hidden with none.
 */
function StarChannels({
  starId,
  channels,
  activities,
  now,
}: {
  starId: string;
  channels: ReadonlyArray<StarChannel>;
  activities: Map<string, Activity>;
  now: number;
}) {
  if (channels.length === 0) return null;
  return (
    <ul className="pult-subagents-list pult-card-channels" aria-label="Channels">
      {channels.map(({ slug, thread }) => {
        const activity = activities.get(keyOf(thread)) ?? null;
        return (
          <li key={slug}>
            <button
              type="button"
              className="pult-subagent"
              title={`Channel ${slug}`}
              onClick={() => run("pult-shell.openStarChannel", starId, slug)}
            >
              <i className="codicon codicon-comment-discussion" aria-hidden />
              <span className="pult-subagent-title">{slug}</span>
              <Status thread={thread} activity={activity} now={now} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The Star's status: Working, while any open channel works, with the longest elapsed time; Awake; or Asleep, with how long `user` has slept. */
function StarStatus({ star, now }: { star: Star; now: number }) {
  if (star.state === "working") {
    // The longest elapsed time is the earliest start.
    const since = star.channels
      .flatMap(({ thread }) =>
        thread.working && thread.workingSince !== null ? [thread.workingSince] : [],
      )
      .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
    return (
      <span className="pult-card-status pult-card-status-working">
        Working
        {since === undefined ? null : <Elapsed since={since} />}
      </span>
    );
  }
  if (star.state === "awake")
    return <span className="pult-card-status pult-star-awake">Awake</span>;
  const since = age(star.asleepSince, now);
  return (
    <span className="pult-card-status pult-star-asleep">
      Asleep{since === "" ? "" : ` · ${since}`}
    </span>
  );
}
