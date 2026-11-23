import type { IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import {
  Direction,
  type Grid,
  type IView,
  Sizing,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { DisposableStore } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { createRoot } from "react-dom/client";

import { detailsCardWidth } from "../../view/detailsCardWidth.ts";
import type { DetailsCards } from "../../view/main.tsx";
import { allowNativeScroll } from "../nativeScroll.ts";
import { allowNativeTextMenu } from "../nativeTextMenu.ts";
import { DetailsTray } from "./DetailsTray.tsx";
import { StarCards } from "./DetailsView.tsx";

/** A column just outside the editor and its strips, beside the workbench’s secondary side bar. */
export function fileDetailsPanel(layout: IWorkbenchLayoutService) {
  const { workbenchGrid, auxiliaryBarPartView } = layout as unknown as {
    workbenchGrid: Grid<IView>;
    auxiliaryBarPartView: IView;
  };
  const element = document.createElement("aside");
  element.className = "pult-thread-view pult-file-details";
  const rows = document.createElement("div");
  rows.className = "pult-file-details-rows";
  const shelves = document.createElement("div");
  shelves.className = "pult-details-island pult-details-panel";
  const tray = document.createElement("div");
  tray.className = "pult-details-island pult-details-tray";
  element.append(rows, shelves, tray);
  allowNativeScroll(element);
  allowNativeTextMenu(element);
  const shelfRoot = createRoot(shelves);
  const trayRoot = createRoot(tray);
  const sash = new DisposableStore();
  const inset = detailsCardWidth.inset;
  let visible = false;
  const view: IView = {
    element,
    minimumWidth: detailsCardWidth.minimum + inset,
    maximumWidth: detailsCardWidth.maximum + inset,
    minimumHeight: 0,
    maximumHeight: Infinity,
    proportionalLayout: false,
    onDidChange: Event.None,
    layout: () => {},
    setBoundarySashes({ left }) {
      sash.clear();
      if (!left) return;
      sash.add(left.addClass("pult-file-details-sash"));
      sash.add(
        left.onDidEnd(() => {
          if (!visible) return;
          detailsCardWidth.set(element.clientWidth - inset);
          detailsCardWidth.keep();
        }),
      );
    },
  };
  workbenchGrid.addView(
    view,
    Sizing.Invisible(detailsCardWidth.get() + inset),
    auxiliaryBarPartView,
    Direction.Left,
  );
  let star = false;
  return {
    rows,
    show(cards: DetailsCards | null) {
      if (visible !== (cards !== null)) {
        visible = cards !== null;
        workbenchGrid.setViewVisible(view, visible);
        if (visible)
          workbenchGrid.resizeView(view, {
            ...workbenchGrid.getViewSize(view),
            width: detailsCardWidth.get() + inset,
          });
      }
      const showStar = cards?.subject.kind === "star";
      if (star !== showStar) {
        star = showStar;
        shelfRoot.render(star ? <StarCards /> : null);
        trayRoot.render(star ? <DetailsTray /> : null);
      }
    },
  };
}
