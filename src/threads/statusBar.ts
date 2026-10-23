import { getService, IConfigurationService } from "@codingame/monaco-vscode-api";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { ThreadInput } from "./pane.tsx";
import { isSwitchingThread, onDidSelectThread } from "./selection.ts";

const STATUS_BAR_VISIBLE = "workbench.statusBar.visible";

/**
 * Shows VS Code's status bar while any editor other than a thread tab is open,
 * in any group, and hides it otherwise. The layout service has no public way
 * to hide the status bar (`setPartVisibility` excludes it), so this sets the
 * setting it follows in the in-memory configuration layer: never written to
 * the user's settings, and above them. Started once the workbench is up.
 */
export async function syncStatusBarWithEditors(): Promise<void> {
  const editors = await getService(IEditorService);
  const configuration = await getService(IConfigurationService);
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
