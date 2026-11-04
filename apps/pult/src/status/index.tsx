import { getService, IConfigurationService, INotificationService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { HoverPosition } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/hover/hoverWidget";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import { IHoverService } from "@codingame/monaco-vscode-api/vscode/vs/platform/hover/browser/hover.service";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { createRoot } from "react-dom/client";

import { composerStrip } from "../composer/index.tsx";
import { modeChoice } from "../mode.ts";
import { isShellTab } from "../threads/pane.tsx";
import { isSwitchingThread, onDidSelectThread } from "../threads/selection.ts";
import { fileStatusStore } from "./status.ts";
import { StatusStrip } from "./StatusStrip.tsx";
import "./status.css";

const STATUS_BAR_VISIBLE = "workbench.statusBar.visible";
/** The status bar's height, which its part fixes. */
const STATUS_BAR_HEIGHT = 22;
/** The strip's, the thread view's bar's (`--pult-bar-height`). */
const STRIP_HEIGHT = 40;
const MORE_STATUSES = "pult-shell.showMoreStatuses";
/** The stock entries the strip draws itself, left out of "more". */
const DRAWN = new Set(["status.editor.mode", "status.editor.selection", "status.problems"]);

/**
 * The parts of the workbench's grid the layout keeps to itself: its grid and
 * the views of the editor part and the status bar. The layout moves views
 * around that grid for the panel's position with the grid's own `moveView`.
 */
interface LayoutGrid {
  readonly workbenchGrid: Grid<IView>;
  readonly editorPartView: IView;
  readonly statusBarPartView: IView;
}

/** The strip as a view of the workbench's grid: a fixed height, any width, laid out by the grid. */
function stripView(): IView {
  const element = document.createElement("div");
  element.className = "pult-status-strip";
  return {
    element,
    minimumWidth: 0,
    maximumWidth: Number.POSITIVE_INFINITY,
    minimumHeight: STRIP_HEIGHT,
    maximumHeight: STRIP_HEIGHT,
    onDidChange: Event.None,
    layout: () => {},
  };
}

/** The strip's element while it is up, for the palette's command to anchor the popover on its "more". */
let stripElement: HTMLElement | undefined;
let statusBarElement: HTMLElement | undefined;

/**
 * "More": the stock status bar's other entries in a popover above `anchor`,
 * the workbench's sticky hover. The stock bar renders its entries whether or
 * not the layout shows it, so each row is a copy of an entry's label as the
 * bar draws it, its first icon in a slot of its own and its text, or its
 * name when it is an icon alone, and a click
 * on a row clicks the entry itself, which runs its command; the entries the
 * strip draws, and those the user hid from the bar, are left out. Read when
 * opened, not live.
 */
async function showMoreStatuses(anchor: HTMLElement): Promise<void> {
  const hovers = await getService(IHoverService);
  const list = document.createElement("div");
  list.className = "pult-status-more";
  const items = [...(statusBarElement?.querySelectorAll<HTMLElement>(".statusbar-item") ?? [])];
  const close = { hover: undefined as { dispose(): void } | undefined };
  for (const item of items) {
    const label = item.querySelector<HTMLElement>("a.statusbar-item-label");
    if (label === null || DRAWN.has(item.id) || item.style.display === "none" || label.style.display === "none") continue;
    if (label.textContent.trim() === "" && label.querySelector(".codicon") === null) continue;
    // One shape per row, an icon's slot then the label: an entry's first icon, or none, and its text, or its name when it is an icon alone.
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pult-status-more-item";
    const name = label.getAttribute("aria-label") ?? "";
    const text = label.textContent.trim();
    row.title = name;
    const slot = document.createElement("span");
    slot.className = "pult-status-more-icon";
    const icon = label.querySelector(".codicon");
    if (icon !== null) slot.append(icon.cloneNode(true));
    const title = document.createElement("span");
    title.className = "pult-status-more-label";
    // An icon-only entry's aria label is prose for a screen reader ("remote", the icon's name); as a label it reads in sentence case.
    title.textContent = text !== "" ? text : name.charAt(0).toUpperCase() + name.slice(1);
    row.append(slot, title);
    row.addEventListener("click", () => {
      close.hover?.dispose();
      label.click();
    });
    list.append(row);
  }
  if (list.childElementCount === 0) {
    const note = document.createElement("div");
    note.className = "pult-status-more-empty";
    note.textContent = "Nothing more to show.";
    list.append(note);
  }
  close.hover = hovers.showInstantHover(
    {
      content: list,
      target: anchor,
      position: { hoverPosition: HoverPosition.ABOVE },
      appearance: { showPointer: true },
      persistence: { sticky: true },
      trapFocus: true,
    },
    true,
  );
}

/**
 * The bar under an open file (xaxis `pult/status-bar-cleanup`): while the
 * active editor is one other than a thread's, a draft's or the settings
 * page's tab, Pult's status strip (`StatusStrip.tsx`), a grid view of its
 * own under the editor part, its "more" a popover of the stock bar's other
 * entries, and in VS Code mode VS Code's status bar instead, moved under
 * the editor part too with the grid's own `moveView` (`pult/decisions`,
 * `status-bar-under-editor`); neither while a thread's tab is active, since
 * the bar belongs to the file shown. The layout has no public way to hide
 * the status bar (`setPartHidden` has no case for it), so its setting is
 * written in the in-memory configuration layer: never to the user's
 * settings, and above them. Started once the workbench is up.
 */
export async function startStatusBar(): Promise<void> {
  const [editors, configuration, mode, status] = await Promise.all([
    getService(IEditorService),
    getService(IConfigurationService),
    modeChoice(),
    fileStatusStore(),
  ]);
  const layout = (await getService(IWorkbenchLayoutService)) as unknown as Partial<LayoutGrid>;
  const { workbenchGrid, editorPartView, statusBarPartView } = layout;
  if (workbenchGrid === undefined || editorPartView === undefined || statusBarPartView === undefined) return;

  // The status bar under the editor part; the strip between the two. A moved
  // view comes back visible, while the layout keeps its own idea of whether
  // the bar is hidden and skips a hide it thinks is done, so the move ends by
  // setting the view's visibility to the setting's.
  workbenchGrid.moveView(statusBarPartView, STATUS_BAR_HEIGHT, editorPartView, Direction.Down);
  workbenchGrid.setViewVisible(statusBarPartView, configuration.getValue(STATUS_BAR_VISIBLE) === true);
  const strip = stripView();
  workbenchGrid.addView(strip, STRIP_HEIGHT, editorPartView, Direction.Down);
  workbenchGrid.setViewVisible(strip, false);
  stripElement = strip.element;
  statusBarElement = statusBarPartView.element;
  createRoot(strip.element).render(<StatusStrip status={status} onMore={(anchor) => void showMoreStatuses(anchor)} />);

  const update = () => {
    if (isSwitchingThread()) return;
    const active = editors.activeEditor;
    const file = active !== undefined && !isShellTab(active);
    const stock = file && mode.current() === "vscode";
    // The composer under a file brings its own bar, which stands in for the strip.
    workbenchGrid.setViewVisible(strip, file && !stock && !composerStrip.get().shown);
    if (configuration.getValue(STATUS_BAR_VISIBLE) !== stock) {
      void configuration.updateValue(STATUS_BAR_VISIBLE, stock, ConfigurationTarget.MEMORY);
    }
  };
  editors.onDidActiveEditorChange(update);
  editors.onDidEditorsChange(update);
  onDidSelectThread(update);
  mode.onDidChange(update);
  composerStrip.subscribe(update);
  update();
}

/** The palette's "Pult: More Statuses…" (`pult-shell.showMoreStatuses`), the strip's "more" anchored on its button, while the strip shows. Registered before the workbench starts. */
export function registerStatusCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: MORE_STATUSES,
          title: { value: "More Statuses…", original: "More Statuses…" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      async run(): Promise<void> {
        const anchor = stripElement?.querySelector<HTMLElement>(".pult-bar-button");
        if (anchor === null || anchor === undefined || anchor.offsetParent === null) {
          return void (await getService(INotificationService)).info("Pult's status bar shows under an open file.");
        }
        await showMoreStatuses(anchor);
      }
    },
  );
}
