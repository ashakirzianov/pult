import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import type { FileStatusStore } from "./status.ts";

function run(command: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command));
}

/**
 * Pult's status strip under an open file (`index.ts`), the thread view's
 * bar's height and type: errors and warnings on the left while there are
 * any, opening Problems; the cursor's line and column, with the selection's
 * size, opening Go to Line; the language, opening VS Code's language
 * picker; and rightmost "more", which swaps in VS Code's own status bar
 * with everything else. Each entry runs the command its stock twin runs.
 */
export function StatusStrip({ status, onMore }: { status: FileStatusStore; onMore: () => void }) {
  const file = useSyncExternalStore(status.subscribe, status.get);
  const position =
    file.line === null || file.column === null
      ? null
      : `Ln ${file.line}, Col ${file.column}${file.selected > 0 ? ` (${file.selected} selected)` : ""}`;
  return (
    <>
      {file.errors > 0 || file.warnings > 0 ? (
        <button
          type="button"
          className="pult-bar-entry pult-status-entry"
          title="Problems"
          onClick={() => run("workbench.actions.view.problems")}
        >
          <span className="codicon codicon-error" aria-hidden />
          {file.errors}
          <span className="codicon codicon-warning" aria-hidden />
          {file.warnings}
        </button>
      ) : null}
      <span className="pult-status-spacer" />
      {position === null ? null : (
        <button
          type="button"
          className="pult-bar-entry pult-status-entry"
          title="Go to Line/Column"
          onClick={() => run("workbench.action.gotoLine")}
        >
          {position}
        </button>
      )}
      {file.language === null ? null : (
        <button
          type="button"
          className="pult-bar-entry pult-status-entry"
          title="Select Language Mode"
          onClick={() => run("workbench.action.editor.changeLanguageMode")}
        >
          {file.language}
        </button>
      )}
      <button type="button" className="pult-bar-entry pult-bar-button" title="More statuses" aria-label="More statuses" onClick={onMore}>
        <span className="codicon codicon-ellipsis" aria-hidden />
      </button>
    </>
  );
}
