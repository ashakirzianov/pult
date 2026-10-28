import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { useSyncExternalStore } from "react";

import { toHostPath } from "../files/paths.ts";
import { openExplorerFiles } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The Explorer card, the panel's first: the Explorer workspace, files opened
 * under no thread (`pult-shell.selectExplorer`), then its open files, each
 * opening the workspace at its tab; selected while the workspace is.
 */
export function ExplorerCard({ selected }: { selected: boolean }) {
  const files = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  return (
    <li className={`pult-card pult-card-explorer${selected ? " pult-card-selected" : ""}`}>
      <button type="button" className="pult-card-select" aria-current={selected || undefined} onClick={() => run("pult-shell.selectExplorer")}>
        <span className="pult-card-heading">
          <i className="codicon codicon-files" aria-hidden />
          <span>Explorer</span>
        </span>
      </button>
      {files.length > 0 ? (
        <ul className="pult-explorer-files">
          {files.map((file) => (
            <li key={file.toString()}>
              <button type="button" className="pult-explorer-file" title={describe(file)} onClick={() => run("pult-shell.selectExplorer", file.toString())}>
                <i className="codicon codicon-file" aria-hidden />
                <span className="pult-explorer-file-name">{baseName(file)}</span>
                <span className="pult-explorer-file-folder">{folderName(file)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function baseName(file: URI): string {
  return file.path.slice(file.path.lastIndexOf("/") + 1) || file.path;
}

/** The folder the file is in, by its name. */
function folderName(file: URI): string {
  const parent = file.path.slice(0, file.path.lastIndexOf("/"));
  return parent.slice(parent.lastIndexOf("/") + 1);
}

/** The file's host path, and its environment's name while the page holds several. */
function describe(file: URI): string {
  const environment = file.scheme === "pult" ? threadStore.distinguishing(threadStore.get().environments.find((candidate) => candidate.id.toLowerCase() === file.authority.toLowerCase())?.id ?? "") : undefined;
  const path = file.scheme === "pult" ? toHostPath(file.path) : file.toString(true);
  return environment === undefined ? path : `${path} (${environment})`;
}
