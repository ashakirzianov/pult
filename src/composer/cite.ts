import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import { Action2, MenuId, MenuRegistry, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ICodeEditorService } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service";

import { relativeTo, toHostPath } from "../files/paths.ts";
import { selectedDraft, selectedThread } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { composerStrip, HasComposerContext, selectedTarget } from "./index.tsx";

const CITE_SELECTION = "pult-shell.citeSelection";

/** Where Cite applies: a `pult:` file, not a side of a diff, while a thread or a project's draft is selected. */
const CITABLE = ContextKeyExpr.and(HasComposerContext, ContextKeyExpr.equals("resourceScheme", "pult"), ContextKeyExpr.not("isInDiffEditor"));

/** The selected thread's or draft's root, which a cited file's path is relative to. */
function selectedRoot(): string | undefined {
  const thread = selectedThread();
  if (thread !== undefined) {
    const shown = threadStore.thread(thread.environmentId, thread.threadId);
    return shown?.projectRoot ?? (shown === undefined ? undefined : threadStore.project(shown.environmentId, shown.projectId)?.root) ?? undefined;
  }
  const draft = selectedDraft();
  return draft === undefined ? undefined : (threadStore.project(draft.environmentId, draft.projectId)?.root ?? undefined);
}

/**
 * Cite (`pult-shell.citeSelection`, the palette's Pult: Cite Selection, and
 * Cite, first in a file's context menu): the selected lines of the active file, or
 * the cursor's line, as a file comment in the selected thread's or draft's
 * composer (`thread-view/shell/citations.ts`), its path relative to the
 * thread's root, and the composer shown under the file. Hidden for a file of
 * the Explorer workspace, which has no thread. Registered before the
 * workbench starts.
 */
export function registerCiteCommand(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: CITE_SELECTION,
          title: { value: "Cite Selection", original: "Cite Selection" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          precondition: CITABLE,
        });
      }

      async run(accessor: Parameters<Action2["run"]>[0]): Promise<void> {
        const editors = accessor.get(ICodeEditorService);
        const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
        const model = editor?.getModel();
        const selection = editor?.getSelection();
        const target = selectedTarget();
        const notify = async (message: string) => (await getService(INotificationService)).info(message);
        if (model === null || model === undefined || selection === null || selection === undefined || model.uri.scheme !== "pult") {
          return void (await notify("Cite takes lines of an open file."));
        }
        if (target === null) return void (await notify("Cite cites into the selected thread's composer."));
        const hostPath = toHostPath(model.uri.path);
        const root = selectedRoot();
        // A selection ending at a line's start does not take that line.
        const endLine =
          selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
        const { citeFileLines } = await import("../../thread-view/shell/citations.ts");
        const cited = citeFileLines(target, {
          path: (root === undefined ? undefined : relativeTo(root, hostPath)) || hostPath,
          startLine: selection.startLineNumber,
          endLine,
          contents: model.getValue(),
        });
        if (!cited) return void (await notify("The composer is not ready yet. Try again in a moment."));
        composerStrip.setOpen(true);
      }
    },
  );
  MenuRegistry.appendMenuItem(MenuId.EditorContext, {
    command: { id: CITE_SELECTION, title: "Cite" },
    group: "navigation",
    order: -1000,
    when: CITABLE,
  });
}
