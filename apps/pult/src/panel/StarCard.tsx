import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { Separator, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { flatStar } from "../stars/flat/star.ts";
import "../stars/flat/star.css";
import { LOOK_STATES, LOOK_WORDS, type StarLook } from "../stars/look.ts";
import { starLookOf, starMarks, tintColor } from "../stars/mark.ts";
import { canSleepStar } from "../stars/model.ts";
import { type Star, starName } from "../stars/stars.ts";
import { JumpHint } from "./JumpHint.tsx";
import { starKey } from "./order.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The square's context menu: Refresh Context while the Star can be put to
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
 * per square, since each holds ids of its own, and a change of look set on its
 * `data-state`, so the halo's motion carries on from where it was. Its colour
 * is the tint's in the theme's scheme, set on the element around it.
 */
export function StarMark({ look, color }: { look: StarLook; color: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const mark = element.querySelector(".flat-star");
    if (mark === null) element.innerHTML = flatStar(LOOK_STATES[look]);
    else mark.setAttribute("data-state", LOOK_STATES[look]);
  }, [look]);
  return <span ref={ref} className="pult-star-mark" style={{ color }} aria-hidden />;
}

/**
 * A Star's square on the Stars' shelf (`star-card`): its mark at 32px
 * (`StarMark`, its look by `look.ts` in `src/stars/`) over its name ("Star"
 * while it has none), and nothing else, its label naming the Star and its
 * look in words. A click selects the Star (`pult-shell.selectStar`), a
 * right-click opens its menu. Selected, it takes the selected card's
 * background; its details are the Details column's (`src/details/`).
 */
export function StarCard({ star, selected }: { star: Star; selected: boolean }) {
  const select = () => run("pult-shell.selectStar", star.id);
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  const look = starLookOf(star, marks);
  return (
    <li className={`pult-card pult-star-square${selected ? " pult-card-selected" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        aria-current={selected || undefined}
        aria-label={`${starName(star)}, ${LOOK_WORDS[look]}`}
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
        <StarMark look={look} color={tintColor(star.tint, marks.scheme)} />
        <span className="pult-star-name">{starName(star)}</span>
        <JumpHint rowKey={starKey(star.id)} />
      </div>
    </li>
  );
}
