import { getService, ICommandService, IViewsService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { projectIconUri } from "../threads/projectIcon.ts";
import { explorerFilter } from "./explorer.ts";

const FILE_VIEW_ID = "workbench.explorer.fileView";

/**
 * The Explorer tab's filter, a row of its own above the tree while the
 * folders are narrowed to the selected thread's root: a pill with the
 * project's icon and name and the thread's title (the project alone for a
 * draft), whose clear mark shows the environment's home instead.
 */
function FilterRow() {
  const filter = useSyncExternalStore(explorerFilter.subscribe, explorerFilter.get);
  if (filter === undefined) return null;
  return (
    <div className="pult-explorer-filter-pill" title={`Only ${filter.path}`}>
      <img className="pult-explorer-filter-icon" src={projectIconUri(filter.projectName, filter.projectIcon).toString(true)} alt="" />
      <span className="pult-explorer-filter-project">{filter.projectName}</span>
      {filter.threadTitle !== undefined && <span className="pult-explorer-filter-thread">{filter.threadTitle}</span>}
      <button
        type="button"
        className="pult-explorer-filter-clear codicon codicon-close"
        aria-label="Clear the filter"
        title="Clear the filter: show the home folder"
        onClick={() => void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.openEnvironmentExplorer"))}
      />
    </div>
  );
}

/**
 * Puts the filter's row in the file view, before its tree, each time the
 * view shows: the view has no slot for one, so the row is an element of
 * the shell's own in the view's body, which `panel.css` lays out as a
 * column. The row is the tree's height (22px), and the tree keeps that much
 * empty space below its last item, so the tree, laid out for the whole
 * body, loses only that space to the row. The explorer recreates the view
 * when its folders go from none to some, and the row moves to the new one.
 */
export async function mountFilterRow(): Promise<void> {
  let mounted: { readonly host: HTMLElement; readonly root: Root } | undefined;
  const mount = () => {
    const tree = document.querySelector<HTMLElement>(".part.sidebar .explorer-folders-view");
    if (tree === null || mounted?.host === tree.previousElementSibling) return;
    mounted?.root.unmount();
    mounted?.host.remove();
    const host = document.createElement("div");
    host.className = "pult-explorer-filter";
    tree.before(host);
    const root = createRoot(host);
    root.render(<FilterRow />);
    mounted = { host, root };
  };
  (await getService(IViewsService)).onDidChangeViewVisibility(({ id, visible }) => {
    if (id === FILE_VIEW_ID && visible) mount();
  });
  mount();
}
