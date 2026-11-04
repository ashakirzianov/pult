import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { useSyncExternalStore } from "react";

import { toHostPath } from "../files/paths.ts";
import { explorerSelected, onDidSelectThread, openExplorerFiles } from "../threads/selection.ts";
import type { ShellEnvironment } from "../threads/store.ts";
import { CollapsibleHeader, useExpanded } from "./collapsible.tsx";
import { exploredEnvironment } from "./explorer.ts";
import { EXPANDED_KEYS, explorerHighlight } from "./jump.ts";
import { JumpHint } from "./JumpHint.tsx";
import { explorerEntries, shown } from "./order.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The Explorer shelf, the panel's first: the Explorer workspace, files opened
 * under no thread, under its collapsible header, open until closed. A row
 * per held environment, selecting the workspace with the Explorer tab at
 * its folder above its projects (`pult-shell.exploreEnvironment`), its open files under it,
 * each selecting the workspace at its tab; files of no held environment
 * last (`explorerEntries`). While the workspace is selected, its active file's row is
 * highlighted, or with none listed the environment's explored last;
 * collapsed, the shelf still shows that row. The files' rows are among the jumps (`jump.ts`).
 */
export function ExplorerShelf({ environments }: { environments: ReadonlyArray<ShellEnvironment> }) {
  const { files } = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  useSyncExternalStore(exploredEnvironment.subscribe, exploredEnvironment.get);
  useSyncExternalStore(onDidSelectThread, explorerSelected);
  const [expanded, setExpanded] = useExpanded(EXPANDED_KEYS.explorer, true);
  if (environments.length === 0 && files.length === 0) return null;
  // Read on a change of the selection, the files or the environment explored, each of which re-renders the shelf.
  const highlighted = explorerHighlight();
  const names = new Map(environments.map((environment) => [environment.id, environment.name]));
  const entries = explorerEntries(
    environments.map((environment) => environment.id),
    files,
  );
  const shownEntries = shown(entries, expanded, (entry) => entry.key === highlighted);
  return (
    <li className="pult-shelf pult-shelf-explorer">
      <CollapsibleHeader
        label="Explorer"
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {shownEntries.length > 0 ? (
        <ul className="pult-explorer-entries">
          {shownEntries.map((entry) => (
            <li key={entry.key}>
              {entry.kind === "environment" ? (
                <EntryButton
                  icon="root-folder"
                  label={names.get(entry.environmentId) ?? entry.environmentId}
                  title={`Explore ${names.get(entry.environmentId) ?? entry.environmentId}'s projects`}
                  nested={false}
                  selected={entry.key === highlighted}
                  onClick={() => run("pult-shell.exploreEnvironment", entry.environmentId)}
                />
              ) : (
                <EntryButton
                  icon="file"
                  label={baseName(entry.file)}
                  detail={folderName(entry.file)}
                  title={
                    entry.file.scheme === "pult"
                      ? toHostPath(entry.file.path)
                      : entry.file.toString(true)
                  }
                  nested={entry.nested}
                  selected={entry.key === highlighted}
                  jumpKey={entry.key}
                  onClick={() => run("pult-shell.selectExplorer", entry.key)}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function EntryButton({
  icon,
  label,
  detail,
  title,
  nested,
  selected,
  jumpKey,
  onClick,
}: {
  icon: string;
  label: string;
  detail?: string;
  title: string;
  nested: boolean;
  selected: boolean;
  /** The row's key among the jumps, for a row they reach. */
  jumpKey?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pult-explorer-entry${nested ? " pult-explorer-entry-nested" : ""}${selected ? " pult-explorer-entry-selected" : ""}`}
      aria-current={selected || undefined}
      title={title}
      onClick={onClick}
    >
      <i className={`codicon codicon-${icon}`} aria-hidden />
      <span className="pult-explorer-entry-name">{label}</span>
      {detail !== undefined ? <span className="pult-explorer-entry-detail">{detail}</span> : null}
      {jumpKey !== undefined ? <JumpHint rowKey={jumpKey} /> : null}
    </button>
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
