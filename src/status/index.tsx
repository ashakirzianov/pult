import { getService, IConfigurationService, IStatusbarService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import { StatusbarAlignment } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/statusbar/browser/statusbar";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { createRoot } from "react-dom/client";

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
const TOGGLE_DETAILS = "pult-shell.toggleStatusDetails";

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

/** Whether "more" has swapped VS Code's status bar in for the strip; the strip comes back on the bar's first entry. */
let details = false;
const detailsListeners = new Set<() => void>();

function toggleDetails(): void {
  details = !details;
  for (const listener of detailsListeners) listener();
}

/**
 * The bar under an open file (xaxis `pult/status-bar-cleanup`): while the
 * active editor is one other than a thread's, a draft's or the settings
 * page's tab, Pult's status strip (`StatusStrip.tsx`), a grid view of its
 * own under the editor part, and in VS Code mode, or while "more" has
 * swapped it in, VS Code's status bar instead, moved under the editor part
 * too with the grid's own `moveView` (`pult/decisions`,
 * `status-bar-under-editor`); neither while a thread's tab is active, since
 * the bar belongs to the file shown. The layout has no public way to hide
 * the status bar (`setPartHidden` has no case for it), so its setting is
 * written in the in-memory configuration layer: never to the user's
 * settings, and above them. Started once the workbench is up.
 */
export async function startStatusBar(): Promise<void> {
  const [editors, configuration, statusbar, mode, status] = await Promise.all([
    getService(IEditorService),
    getService(IConfigurationService),
    getService(IStatusbarService),
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
  createRoot(strip.element).render(<StatusStrip status={status} onMore={toggleDetails} />);

  // The stock bar's way back to the strip, its first entry; not in VS Code mode, where the stock bar is the bar.
  let back: IDisposable | undefined;
  const update = () => {
    if (isSwitchingThread()) return;
    const active = editors.activeEditor;
    const file = active !== undefined && !isShellTab(active);
    const vscode = mode.current() === "vscode";
    const stock = file && (vscode || details);
    workbenchGrid.setViewVisible(strip, file && !stock);
    if (configuration.getValue(STATUS_BAR_VISIBLE) !== stock) {
      void configuration.updateValue(STATUS_BAR_VISIBLE, stock, ConfigurationTarget.MEMORY);
    }
    if (vscode) {
      back?.dispose();
      back = undefined;
    } else {
      back ??= statusbar.addEntry(
        {
          name: "Pult: Fewer Statuses",
          text: "$(chevron-left)",
          ariaLabel: "Fewer statuses",
          tooltip: "Back to Pult's status bar",
          command: TOGGLE_DETAILS,
        },
        "pult.status.fewer",
        StatusbarAlignment.LEFT,
        1000,
      );
    }
  };
  editors.onDidActiveEditorChange(update);
  editors.onDidEditorsChange(update);
  onDidSelectThread(update);
  mode.onDidChange(update);
  detailsListeners.add(update);
  update();
}

/** The palette's "Pult: Toggle Status Bar Details" (`pult-shell.toggleStatusDetails`), the strip's "more" and the stock bar's way back. Registered before the workbench starts. */
export function registerStatusCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: TOGGLE_DETAILS,
          title: { value: "Toggle Status Bar Details", original: "Toggle Status Bar Details" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(): void {
        toggleDetails();
      }
    },
  );
}
