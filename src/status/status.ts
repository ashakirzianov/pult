import { getService, IEditorService, ILanguageService, IMarkerService } from "@codingame/monaco-vscode-api";
import { type ICodeEditor, isCodeEditor, isDiffEditor } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser";
import { DisposableStore } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { MarkerSeverity } from "@codingame/monaco-vscode-api/vscode/vs/platform/markers/common/markers";

/** What the status strip shows of the active file: nothing of it while no text editor is active. */
export interface FileStatus {
  /** The language's name, as VS Code's language mode entry shows it. */
  readonly language: string | null;
  readonly line: number | null;
  readonly column: number | null;
  /** Characters selected across the selections, 0 for a caret. */
  readonly selected: number;
  readonly errors: number;
  readonly warnings: number;
}

const EMPTY: FileStatus = { language: null, line: null, column: null, selected: 0, errors: 0, warnings: 0 };

/**
 * The active file's status, read from the workbench's own services as VS
 * Code's status bar entries read it: the active text editor's model and
 * cursor (the diff editor's modified side), and every marker the marker
 * service holds, as the problems entry counts them. A store for
 * `useSyncExternalStore`: the snapshot changes only when a value does.
 */
export async function fileStatusStore() {
  const [editors, languages, markers] = await Promise.all([
    getService(IEditorService),
    getService(ILanguageService),
    getService(IMarkerService),
  ]);
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();

  const activeEditor = (): ICodeEditor | undefined => {
    const control = editors.activeTextEditorControl;
    if (isDiffEditor(control)) return control.getModifiedEditor();
    return isCodeEditor(control) ? control : undefined;
  };

  const read = (): FileStatus => {
    const editor = activeEditor();
    const model = editor?.getModel();
    const position = editor?.getPosition();
    const selected =
      editor?.getSelections()?.reduce((count, selection) => count + (model?.getValueLengthInRange(selection) ?? 0), 0) ?? 0;
    const counts = { errors: 0, warnings: 0 };
    for (const marker of markers.read({ severities: MarkerSeverity.Error | MarkerSeverity.Warning })) {
      if (marker.severity === MarkerSeverity.Error) counts.errors += 1;
      else counts.warnings += 1;
    }
    return {
      language: model === undefined || model === null ? null : languages.getLanguageName(model.getLanguageId()),
      line: position?.lineNumber ?? null,
      column: position?.column ?? null,
      selected,
      ...counts,
    };
  };

  const refresh = () => {
    const next = read();
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  // The editor's own events are bound anew as the active editor changes.
  const editorEvents = new DisposableStore();
  const follow = () => {
    editorEvents.clear();
    const editor = activeEditor();
    if (editor !== undefined) {
      editorEvents.add(editor.onDidChangeCursorSelection(refresh));
      editorEvents.add(editor.onDidChangeModel(refresh));
      editorEvents.add(editor.onDidChangeModelLanguage(refresh));
    }
    refresh();
  };
  editors.onDidActiveEditorChange(follow);
  markers.onMarkerChanged(refresh);
  follow();

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => snapshot,
  };
}

export type FileStatusStore = Awaited<ReturnType<typeof fileStatusStore>>;
