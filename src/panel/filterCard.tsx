import { getService, ICommandService, IViewsService } from "@codingame/monaco-vscode-api";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { toHostPath } from "../files/paths.ts";
import { projectIconUri, useProjectIcons } from "../threads/projectIcon.ts";
import { explorerFilter } from "./explorer.ts";

const FILE_VIEW_ID = "workbench.explorer.fileView";

/**
 * The Explorer tab's filter, a card above the tree while the folders are
 * narrowed, in the thread cards' look, with a clear mark on hover that shows
 * every environment's home instead: to the selected thread's root, the
 * project's icon and name, then the thread's title ("New thread" for a
 * draft); to an environment's home, the environment's name, then the home's
 * path.
 */
function FilterCard() {
  const filter = useSyncExternalStore(explorerFilter.subscribe, explorerFilter.get);
  useProjectIcons();
  if (filter === undefined) return null;
  return (
    <div className="pult-explorer-card" title={`Only ${filter.path}`}>
      <span className="pult-card-top">
        {filter.kind === "thread" ? (
          <img className="pult-card-icon" src={projectIconUri(filter.project).toString(true)} alt="" />
        ) : (
          <i className="pult-card-icon codicon codicon-home" aria-hidden />
        )}
        <span className="pult-card-project">{filter.kind === "thread" ? filter.project.name : filter.environment}</span>
        <button
          type="button"
          className="pult-explorer-card-clear codicon codicon-close"
          aria-label="Clear the filter"
          title="Clear the filter: show the home folder"
          onClick={() => void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.openEnvironmentExplorer"))}
        />
      </span>
      <span className="pult-card-title">{filter.kind === "thread" ? (filter.threadTitle ?? "New thread") : toHostPath(filter.path)}</span>
    </div>
  );
}

/** The explorer's tree, as far as the card needs it: its public layout and the scroll events that report its height. */
interface ExplorerTree {
  layout(height: number, width?: number): void;
  onDidScroll(listener: (event: { readonly height: number; readonly heightChanged: boolean }) => void): IDisposable;
}

/** The file view's tree, its field `tree`; undefined if a workbench bump renames it, and the card then costs the tree its bottom. */
function explorerTree(view: unknown): ExplorerTree | undefined {
  if (typeof view !== "object" || view === null || !("tree" in view)) return undefined;
  const { tree } = view;
  if (typeof tree !== "object" || tree === null || !("layout" in tree) || !("onDidScroll" in tree)) return undefined;
  return tree as ExplorerTree;
}

/**
 * Puts the filter's card in the file view, before its tree, each time the
 * view shows: the view has no slot for one, so the card is an element of
 * the shell's own in the view's body, which `panel.css` lays out as a
 * column. The view lays the tree out for its whole body, so the tree is
 * laid out again for the height the card leaves it, whenever that height
 * changes and whenever the view lays it out. The explorer recreates the
 * view when its folders go from none to some, and the card moves to the
 * new one.
 */
export async function mountFilterCard(): Promise<void> {
  const views = await getService(IViewsService);
  let mounted: { readonly container: HTMLElement; readonly root: Root; readonly dispose: () => void } | undefined;
  const mount = () => {
    const container = document.querySelector<HTMLElement>(".part.sidebar .explorer-folders-view");
    if (container === null || mounted?.container === container) return;
    mounted?.dispose();
    const host = document.createElement("div");
    host.className = "pult-explorer-filter";
    container.before(host);
    const root = createRoot(host);
    root.render(<FilterCard />);
    const tree = explorerTree(views.getViewWithId(FILE_VIEW_ID));
    const fit = () => {
      if (container.clientHeight > 0) tree?.layout(container.clientHeight);
    };
    // After the view's own layout has finished, which reports the body's height.
    const relayout = tree?.onDidScroll(({ height, heightChanged }) => {
      if (heightChanged && height !== container.clientHeight) queueMicrotask(fit);
    });
    const resize = new ResizeObserver(fit);
    resize.observe(container);
    mounted = {
      container,
      root,
      dispose: () => {
        resize.disconnect();
        relayout?.dispose();
        root.unmount();
        host.remove();
      },
    };
  };
  views.onDidChangeViewVisibility(({ id, visible }) => {
    if (id === FILE_VIEW_ID && visible) mount();
  });
  mount();
}
