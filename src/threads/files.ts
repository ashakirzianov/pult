import { getService, IFileService, INotificationService } from "@codingame/monaco-vscode-api";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { pultUri } from "../panel/explorer.ts";
import { threadStore } from "./store.ts";

/**
 * Opens a file the thread view names as an editor tab, where upstream would
 * show it in the view's right panel: `path` relative to the thread's
 * project root, or an absolute host path, at `line` when given. The tab
 * goes beside the thread's, in the active group, as a preview that a second
 * file replaces; the extension's `pult:` provider serves it. A path the
 * project does not have, as an agent's mention of a file in another repo,
 * is a notice rather than an editor that fails to open.
 */
export async function openThreadFile(threadId: string, path: string, line: number | null): Promise<void> {
  const { environment, threads } = threadStore.get();
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (environment === null || thread === undefined) return;
  const hostPath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${thread.projectRoot ?? ""}/${path}`;
  const resource = pultUri(environment.id, hostPath);
  const [files, editors, notifications] = await Promise.all([
    getService(IFileService),
    getService(IEditorService),
    getService(INotificationService),
  ]);
  if (!(await files.exists(resource))) {
    notifications.warn(`No ${path} in ${thread.projectName}.`);
    return;
  }
  await editors.openEditor({
    resource,
    options: line === null ? {} : { selection: { startLineNumber: line, startColumn: 1 } },
  });
}
