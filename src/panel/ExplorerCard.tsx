import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { useSyncExternalStore } from "react";

import { toHostPath } from "../files/paths.ts";
import { openExplorerFiles } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { EnvironmentChip } from "./DraftCard.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The Explorer card, the panel's first: the Explorer workspace, files opened
 * under no thread, then its open files, each with its environment's name
 * while the page holds several. A click on the card selects the
 * workspace (`pult-shell.selectExplorer`), on a file the workspace at its
 * tab, and on the title the workspace with the sidebar's Explorer tab too
 * (`pult-shell.exploreFiles`); selected while the workspace is. A button by
 * role, as a thread card, its title and files buttons inside it.
 */
export function ExplorerCard({ selected }: { selected: boolean }) {
  const files = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  const select = () => run("pult-shell.selectExplorer");
  return (
    <li className={`pult-card pult-card-explorer${selected ? " pult-card-selected" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        aria-current={selected || undefined}
        aria-label="Explorer workspace"
        onClick={select}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          select();
        }}
      >
        <button
          type="button"
          className="pult-card-heading"
          title="Explore files"
          onClick={(event) => {
            event.stopPropagation();
            run("pult-shell.exploreFiles");
          }}
        >
          <i className="codicon codicon-files" aria-hidden />
          <span>Explorer</span>
        </button>
        {files.length > 0 ? (
          <ul className="pult-explorer-files">
            {files.map((file) => (
              <li key={file.toString()}>
                <button
                  type="button"
                  className="pult-explorer-file"
                  title={describe(file)}
                  onClick={(event) => {
                    event.stopPropagation();
                    run("pult-shell.selectExplorer", file.toString());
                  }}
                >
                  <i className="codicon codicon-file" aria-hidden />
                  <span className="pult-explorer-file-name">{baseName(file)}</span>
                  <span className="pult-explorer-file-folder">{folderName(file)}</span>
                  <EnvironmentChip label={environmentOf(file)} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
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

/** The name of a `pult:` file's environment while the page holds several, as the cards' chips show it. */
function environmentOf(file: URI): string | undefined {
  if (file.scheme !== "pult") return undefined;
  const environment = threadStore.get().environments.find((candidate) => candidate.id.toLowerCase() === file.authority.toLowerCase());
  return environment === undefined ? undefined : threadStore.distinguishing(environment.id);
}

/** The file's host path, and its environment's name while the page holds several. */
function describe(file: URI): string {
  const environment = environmentOf(file);
  const path = file.scheme === "pult" ? toHostPath(file.path) : file.toString(true);
  return environment === undefined ? path : `${path} (${environment})`;
}
