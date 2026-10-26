import { getService } from "@codingame/monaco-vscode-api";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { pultUri } from "../panel/explorer.ts";
import { threadStore } from "./store.ts";

/**
 * Opens a file the thread view names as an editor tab, where upstream would
 * show it in the view's right panel: `path` relative to the thread's
 * project root, or an absolute host path, at `line` when given. The tab
 * goes beside the thread's, in the active group, as a preview that a second
 * file replaces; the extension's `pult:` provider serves it.
 */
export async function openThreadFile(threadId: string, path: string, line: number | null): Promise<void> {
  const { environment, threads } = threadStore.get();
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (environment === null || thread === undefined) return;
  const hostPath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${thread.projectRoot ?? ""}/${path}`;
  const editors = await getService(IEditorService);
  await editors.openEditor({
    resource: pultUri(environment.id, hostPath),
    options: line === null ? {} : { selection: { startLineNumber: line, startColumn: 1 } },
  });
}
