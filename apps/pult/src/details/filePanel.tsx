import type { IEditorGroupsService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import {
  Orientation,
  Sash,
  SashState,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/sash/sash";
import { mainWindow } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/window";
import { DEFAULT_EDITOR_MIN_DIMENSIONS } from "@codingame/monaco-vscode-api/vscode/vs/workbench/browser/parts/editor/editor";
import {
  Parts,
  Position,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { createRoot } from "react-dom/client";

import { detailsCardWidth } from "../../view/detailsCardWidth.ts";
import type { DetailsCards } from "../../view/main.tsx";
import { allowNativeScroll } from "../nativeScroll.ts";
import { allowNativeTextMenu } from "../nativeTextMenu.ts";
import { DetailsTray } from "./DetailsTray.tsx";
import { DetailsShelves } from "./DetailsView.tsx";

/**
 * The editor part's own inset, upstream's for its docked auxiliary bar
 * (`vs/sessions`): the groups at the part's right edge lay their editors out
 * that much narrower, while their tab rows keep the part's full width.
 */
type InsetEditorPart = {
  setContentRightInset(inset: number): void;
  readonly activeGroup: { readonly titleHeight: { readonly offset: number } };
};

/**
 * A column at the window's right edge, under the editor's tab row and beside
 * the editor and its composer or status strip, as a thread view's cards sit
 * under its tab row: the editor part insets its content by the column's
 * width, and the strips pad theirs by `--pult-file-details-width`.
 */
export function fileDetailsPanel(layout: IWorkbenchLayoutService, groups: IEditorGroupsService) {
  const host = layout.mainContainer;
  const part = layout.getContainer(mainWindow, Parts.EDITOR_PART);
  if (part === undefined) throw new Error("The workbench has no editor part.");
  const editorPart = groups.mainPart as unknown as InsetEditorPart;
  const element = document.createElement("aside");
  element.className = "pult-thread-view pult-file-details";
  element.hidden = true;
  const shelves = document.createElement("div");
  shelves.className = "pult-details-island pult-details-panel";
  const tray = document.createElement("div");
  tray.className = "pult-details-island pult-details-tray";
  element.append(shelves, tray);
  host.append(element);
  allowNativeScroll(element);
  allowNativeTextMenu(element);
  const shelfRoot = createRoot(shelves);
  const trayRoot = createRoot(tray);

  let visible = false;
  // The column's box in the workbench's coordinates, for the sash.
  let box = { left: 0, top: 0, height: 0 };
  const sash = new Sash(
    host,
    {
      getVerticalSashLeft: () => box.left,
      getVerticalSashTop: () => box.top,
      getVerticalSashHeight: () => box.height,
    },
    { orientation: Orientation.VERTICAL },
  );
  sash.addClass("pult-file-details-sash");
  sash.state = SashState.Disabled;
  let dragStart = 0;
  // From the width drawn, which a narrow editor caps below the width kept.
  sash.onDidStart(() => (dragStart = element.offsetWidth - detailsCardWidth.inset));
  sash.onDidChange((event) => detailsCardWidth.set(dragStart + event.startX - event.currentX));
  sash.onDidEnd(() => detailsCardWidth.keep());

  // From under the tab row to the editor column's foot: the window's, or a bottom panel's top.
  const place = () => {
    if (!visible) return;
    const bounds = host.getBoundingClientRect();
    const editor = part.getBoundingClientRect();
    const panel =
      layout.isVisible(Parts.PANEL_PART) && layout.getPanelPosition() === Position.BOTTOM
        ? layout.getContainer(mainWindow, Parts.PANEL_PART)
        : undefined;
    const bottom = panel?.getBoundingClientRect().top ?? bounds.bottom;
    const top = editor.top + editorPart.activeGroup.titleHeight.offset;
    const width = Math.max(
      detailsCardWidth.minimum + detailsCardWidth.inset,
      Math.min(
        detailsCardWidth.get() + detailsCardWidth.inset,
        editor.width - DEFAULT_EDITOR_MIN_DIMENSIONS.width,
      ),
    );
    box = { left: editor.right - width - bounds.left, top: top - bounds.top, height: bottom - top };
    Object.assign(element.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${width}px`,
      height: `${box.height}px`,
    });
    host.style.setProperty("--pult-file-details-width", `${width}px`);
    editorPart.setContentRightInset(width);
    sash.layout();
  };
  // After the whole layout pass, once the views below the editor part have their places too.
  groups.mainPart.onDidLayout(() => queueMicrotask(place));
  detailsCardWidth.subscribe(place);

  return {
    show(cards: DetailsCards | null) {
      if (visible !== (cards !== null)) {
        visible = cards !== null;
        element.hidden = !visible;
        sash.state = visible ? SashState.Enabled : SashState.Disabled;
        if (visible) place();
        else {
          host.style.removeProperty("--pult-file-details-width");
          editorPart.setContentRightInset(0);
        }
        // Only while shown, so the rows and what they read live while they can be seen.
        shelfRoot.render(visible ? <DetailsShelves /> : null);
        trayRoot.render(visible ? <DetailsTray /> : null);
      }
    },
  };
}
