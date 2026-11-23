import { getService, IEditorService } from "@codingame/monaco-vscode-api";

/** Marks the workbench while one tab is open across every group and row, for the default mode's rule hiding its selected mark (`style.css`). */
export async function startLoneTab(): Promise<void> {
  const editors = await getService(IEditorService);
  const workbench = document.querySelector(".monaco-workbench");
  const update = () => workbench?.classList.toggle("pult-lone-tab", editors.count === 1);
  editors.onDidEditorsChange(update);
  // A closing editor's change fires while it still counts.
  editors.onDidCloseEditor(update);
  update();
}
