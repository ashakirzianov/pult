import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { Separator, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { flatStar } from "../stars/flat/star.ts";
import "../stars/flat/star.css";
import type { StarLook } from "../stars/look.ts";
import { starLookOf, starMarks, tintColor } from "../stars/mark.ts";
import { canSleepStar } from "../stars/model.ts";
import { StarStatus } from "../details/StarDetails.tsx";
import { type Star, starName } from "../stars/stars.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { JumpHint } from "./JumpHint.tsx";
import { starKey } from "./order.ts";
import { StarAsksBadge } from "./AskCard.tsx";

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
export function StarMark({ look, color }: { look: StarLook; color: string }) {
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
 * its name ("Star" while it has none) with its asks' count, a click on
 * which opens its first posted ask (`AskCard.tsx`), and its
 * environment's chip while the page holds several,
 * over its state, Asleep with how long (dimmed), Awake,
 * or Working with its elapsed time (`StarStatus`). A click selects the Star
 * (`pult-shell.selectStar`), a right-click opens its menu. Selected, it
 * grows no details: those are the Details column's (`src/details/`).
 */
export function StarCard({
  star,
  environment,
  selected,
  now,
}: {
  star: Star;
  environment: string | undefined;
  selected: boolean;
  now: number;
}) {
  const select = () => run("pult-shell.selectStar", star.id);
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
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
    </li>
  );
}
