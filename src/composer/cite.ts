import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import { Action2, MenuId, MenuRegistry, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ICodeEditorService } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service";

import type { ICodeEditor } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser";

import { relativeTo, toHostPath } from "../files/paths.ts";
import { selectedDraft, selectedThread } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { diffExcerpt } from "./diffExcerpt.ts";
import { composerStrip, HasComposerContext, selectedTarget } from "./index.tsx";

const CITE_SELECTION = "pult-shell.citeSelection";

/** The changes view's diff sides (`src/changes/view.ts`), whose query names the change. */
const DIFF_SCHEME = "pult-diff";

/** Where Cite applies: a `pult:` file, or a side of the changes view's diff, while a thread or a project's draft is selected. */
const CITABLE = ContextKeyExpr.and(
  HasComposerContext,
  ContextKeyExpr.or(ContextKeyExpr.equals("resourceScheme", "pult"), ContextKeyExpr.equals("resourceScheme", DIFF_SCHEME), ContextKeyExpr.has("isInDiffEditor")),
);

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
 * The changes view's diff `editor` is a side of, with both sides' lines and
 * the diff's mappings: the change's path, relative to the thread's root, and
 * source from the old side's `pult-diff:` query.
 */
function changesDiff(diffs: ReturnType<ICodeEditorService["listDiffEditors"]>, editor: ICodeEditor) {
  const diff = diffs.find((candidate) => candidate.getOriginalEditor() === editor || candidate.getModifiedEditor() === editor);
  const original = diff?.getOriginalEditor().getModel();
  const modified = diff?.getModifiedEditor().getModel();
  const mappings = diff?.getDiffComputationResult()?.changes2;
  if (original === null || original === undefined || modified === null || modified === undefined || mappings === undefined) return undefined;
  if (original.uri.scheme !== DIFF_SCHEME) return undefined;
  const { change } = JSON.parse(original.uri.query) as { change: { path: string; sourceKind: string } };
  return {
    path: change.path,
    source: change.sourceKind === "working-tree" ? ("Uncommitted" as const) : ("Changes" as const),
    side: diff?.getOriginalEditor() === editor ? ("old" as const) : ("new" as const),
    original: original.getLinesContent(),
    modified: modified.getLinesContent(),
    mappings,
  };
}

/**
 * Cite (`pult-shell.citeSelection`, the palette's Pult: Cite Selection, and
 * Cite, first in a file's context menu and in either side of the changes
 * view's diff): the selected lines of the active file, or the cursor's line,
 * as a file comment in the selected thread's or draft's composer
 * (`thread-view/shell/citations.ts`), its path relative to the thread's
 * root; in a diff, as a diff comment of the lines and the other side's
 * between them (`diffExcerpt.ts`), labelled with the diff's source; and the
 * composer shown under the file. Hidden for a file of the Explorer
 * workspace, which has no thread. Registered before the workbench starts.
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
        if (editor === null || editor === undefined || model === null || model === undefined || selection === null || selection === undefined) {
          return void (await notify("Cite takes lines of an open file."));
        }
        if (target === null) return void (await notify("Cite cites into the selected thread's composer."));
        // A selection ending at a line's start does not take that line.
        const endLine =
          selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
        const citations = await import("../../thread-view/shell/citations.ts");
        const diff = changesDiff(editors.listDiffEditors(), editor);
        let cited: boolean;
        if (diff !== undefined) {
          const excerpt = diffExcerpt({ ...diff, startLine: selection.startLineNumber, endLine });
          if (excerpt === null) return void (await notify("Cite takes lines of the diff."));
          cited = citations.citeDiffLines(target, {
            ...excerpt,
            path: diff.path,
            source: diff.source,
            side: diff.side === "old" ? "deletions" : "additions",
            startLine: selection.startLineNumber,
            endLine,
          });
        } else if (model.uri.scheme === "pult") {
          const hostPath = toHostPath(model.uri.path);
          const root = selectedRoot();
          cited = citations.citeFileLines(target, {
            path: (root === undefined ? undefined : relativeTo(root, hostPath)) || hostPath,
            startLine: selection.startLineNumber,
            endLine,
            contents: model.getValue(),
          });
        } else {
          return void (await notify("Cite takes lines of a thread's file or of its changes."));
        }
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
