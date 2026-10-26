import { getService, IConfigurationService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { ThreadInput } from "./pane.tsx";
import { isSwitchingThread, onDidSelectThread } from "./selection.ts";

const STATUS_BAR_VISIBLE = "workbench.statusBar.visible";

/**
 * Shows VS Code's status bar while any editor other than a thread tab is open,
 * in any group, and hides it otherwise. The layout service has no public way
 * to hide the status bar (`setPartHidden` has no case for it), so this sets the
 * setting it follows in the in-memory configuration layer: never written to
 * the user's settings, and above them. Started once the workbench is up.
 */
export async function syncStatusBarWithEditors(): Promise<void> {
  const editors = await getService(IEditorService);
  const configuration = await getService(IConfigurationService);
  await placeStatusBarUnderEditors();
  const update = () => {
    if (isSwitchingThread()) return;
    const visible = editors.editors.some((editor) => !(editor instanceof ThreadInput));
    if (configuration.getValue(STATUS_BAR_VISIBLE) !== visible) {
      void configuration.updateValue(STATUS_BAR_VISIBLE, visible, ConfigurationTarget.MEMORY);
    }
  };
  editors.onDidEditorsChange(update);
  onDidSelectThread(update);
  update();
}

/** The status bar's height, which its part fixes. */
const STATUS_BAR_HEIGHT = 22;

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

/**
 * Moves the status bar from the bottom of the window to the bottom of the
 * editor part, so it runs under the tabs' content and not under the sidebar.
 * The workbench offers no setting for it; its layout moves the panel the
 * same way, and the grid keeps the status bar at its fixed height.
 */
async function placeStatusBarUnderEditors(): Promise<void> {
  const layout = (await getService(IWorkbenchLayoutService)) as unknown as Partial<LayoutGrid>;
  const { workbenchGrid, editorPartView, statusBarPartView } = layout;
  if (workbenchGrid === undefined || editorPartView === undefined || statusBarPartView === undefined) return;
  workbenchGrid.moveView(statusBarPartView, STATUS_BAR_HEIGHT, editorPartView, Direction.Down);
}
