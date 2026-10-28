import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { useSyncExternalStore } from "react";

import { toHostPath } from "../files/paths.ts";
import { openExplorerFiles } from "../threads/selection.ts";
import type { ShellEnvironment } from "../threads/store.ts";
import { CollapsibleHeader, useExpanded } from "./collapsible.tsx";
import { exploredEnvironment } from "./explorer.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** A row of the shelf: an environment's home, or an open file. */
interface Entry {
  readonly key: string;
  readonly node: React.ReactNode;
}

/**
 * The Explorer shelf, the panel's first: the Explorer workspace, files opened
 * under no thread, under its collapsible header, open until closed. A row
 * per held environment, selecting the workspace with the Explorer tab at
 * its home (`pult-shell.exploreEnvironment`), its open files under it,
 * each selecting the workspace at its tab; files of no held environment
 * last. While the workspace is `selected`, its active file's row is
 * highlighted, or with none listed the environment's explored last;
 * collapsed, the shelf still shows that row.
 */
export function ExplorerShelf({ selected, environments }: { selected: boolean; environments: ReadonlyArray<ShellEnvironment> }) {
  const { files, active } = useSyncExternalStore(openExplorerFiles.subscribe, openExplorerFiles.get);
  const explored = useSyncExternalStore(exploredEnvironment.subscribe, exploredEnvironment.get);
  const [expanded, setExpanded] = useExpanded("pult-shell.panel.explorer-expanded", true);
  if (environments.length === 0 && files.length === 0) return null;
  const activeFile = selected && active !== undefined ? files.find((file) => file.toString() === active.toString()) : undefined;
  const highlighted = activeFile?.toString() ?? (selected && explored !== undefined ? environmentKey(explored) : undefined);
  const ofEnvironment = (file: URI, environment: ShellEnvironment) =>
    file.scheme === "pult" && file.authority.toLowerCase() === environment.id.toLowerCase();
  const fileEntry = (file: URI, nested: boolean): Entry => ({
    key: file.toString(),
    node: (
      <EntryButton
        icon="file"
        label={baseName(file)}
        detail={folderName(file)}
        title={file.scheme === "pult" ? toHostPath(file.path) : file.toString(true)}
        nested={nested}
        selected={file.toString() === highlighted}
        onClick={() => run("pult-shell.selectExplorer", file.toString())}
      />
    ),
  });
  const entries: Entry[] = [
    ...environments.flatMap((environment) => [
      {
        key: environmentKey(environment.id),
        node: (
          <EntryButton
            icon="home"
            label={environment.name}
            title={`Explore ${environment.name}'s home folder`}
            nested={false}
            selected={environmentKey(environment.id) === highlighted}
            onClick={() => run("pult-shell.exploreEnvironment", environment.id)}
          />
        ),
      },
      ...files.filter((file) => ofEnvironment(file, environment)).map((file) => fileEntry(file, true)),
    ]),
    ...files.filter((file) => !environments.some((environment) => ofEnvironment(file, environment))).map((file) => fileEntry(file, false)),
  ];
  const shown = expanded ? entries : entries.filter((entry) => entry.key === highlighted);
  return (
    <li className="pult-shelf pult-shelf-explorer">
      <CollapsibleHeader label="Explorer" expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      {shown.length > 0 ? (
        <ul className="pult-explorer-entries">
          {shown.map((entry) => (
            <li key={entry.key}>{entry.node}</li>
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
  onClick,
}: {
  icon: string;
  label: string;
  detail?: string;
  title: string;
  nested: boolean;
  selected: boolean;
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
    </button>
  );
}

const environmentKey = (environmentId: string) => `environment:${environmentId}`;

function baseName(file: URI): string {
  return file.path.slice(file.path.lastIndexOf("/") + 1) || file.path;
}

/** The folder the file is in, by its name. */
function folderName(file: URI): string {
  const parent = file.path.slice(0, file.path.lastIndexOf("/"));
  return parent.slice(parent.lastIndexOf("/") + 1);
}
