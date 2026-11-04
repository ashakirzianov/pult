import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";

import { composerStrip } from "../composer/index.tsx";
import type { FileStatusStore } from "./status.ts";

function run(command: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command));
}

/**
 * Pult's status strip under an open file (`index.ts`), the thread view's
 * bar's height and type: errors and warnings on the left while there are
 * any, opening Problems; the cursor's line and column, with the selection's
 * size, opening Go to Line; the language, opening VS Code's language
 * picker; and rightmost "more", a popover of the stock status bar's other
 * entries (`index.tsx`). Each entry runs the command its stock twin runs.
 * First, while a thread or draft is selected, the composer's entry
 * (`src/composer/`): "Composer", marked while that composer holds anything,
 * showing it under the file, whose own bar then stands in for this strip.
 */
export function StatusStrip({ status, onMore }: { status: FileStatusStore; onMore: (anchor: HTMLElement) => void }) {
  const file = useSyncExternalStore(status.subscribe, status.get);
  const composer = useSyncExternalStore(composerStrip.subscribe, composerStrip.get);
  const position =
    file.line === null || file.column === null
      ? null
      : `Ln ${file.line}, Col ${file.column}${file.selected > 0 ? ` (${file.selected} selected)` : ""}`;
  return (
    <>
      {composer.available ? (
        <button
          type="button"
          className="pult-bar-entry pult-status-entry"
          title={composer.filled ? "Show the composer, which holds a draft" : "Show the composer"}
          onClick={() => run("pult-shell.showComposer")}
        >
          <span className="codicon codicon-comment" aria-hidden />
          Composer
          {composer.filled ? <span className="pult-status-dot" aria-label="holds a draft" /> : null}
        </button>
      ) : null}
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
      <button
        type="button"
        className="pult-bar-entry pult-bar-button"
        title="More statuses"
        aria-label="More statuses"
        onClick={(event) => onMore(event.currentTarget)}
      >
        <span className="codicon codicon-ellipsis" aria-hidden />
      </button>
    </>
  );
}
