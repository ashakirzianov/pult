import { getService, ICommandService, IViewsService } from "@codingame/monaco-vscode-api";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { toHostPath } from "../files/paths.ts";
import { projectIconUri, useProjectIcons } from "../threads/projectIcon.ts";
import { explorerFilter } from "./explorer.ts";

const FILE_VIEW_ID = "workbench.explorer.fileView";

/**
 * A stock view's filter as a card above its tree, in the thread cards' look:
 * an icon and a line of text, with a clear mark on hover that `onClear`
 * runs, then a title, and a muted line under it with its codicon when given
 * (Source Control's branch).
 */
export function ViewFilterCard(props: {
  readonly icon: ReactNode;
  readonly top: string;
  readonly title: string;
  readonly detail?: { readonly codicon: string; readonly text: string };
  readonly tooltip: string;
  readonly clearTitle: string;
  readonly onClear: () => void;
}) {
  return (
    <div className="pult-view-card" title={props.tooltip}>
      <span className="pult-card-top">
        {props.icon}
        <span className="pult-card-project">{props.top}</span>
        <button
          type="button"
          className="pult-view-card-clear codicon codicon-close"
          aria-label="Clear the filter"
          title={props.clearTitle}
          onClick={props.onClear}
        />
      </span>
      <span className="pult-card-title">{props.title}</span>
      {props.detail === undefined ? null : (
        <span className="pult-view-card-detail">
          <i className={`codicon codicon-${props.detail.codicon}`} aria-hidden />
          <span>{props.detail.text}</span>
        </span>
      )}
    </div>
  );
}

/** Runs a workbench command, for a card's clear mark. */
export function runCommand(id: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(id));
}

/**
 * The Explorer tab's filter, while the folders are narrowed, its clear mark
 * showing every environment's folder above its projects instead: to the
 * selected thread's root, the project's icon and name, then the thread's
 * title ("New thread" for a draft); to an environment's folder, its name,
 * then its path.
 */
function ExplorerCard() {
  const filter = useSyncExternalStore(explorerFilter.subscribe, explorerFilter.get);
  useProjectIcons();
  if (filter === undefined) return null;
  return (
    <ViewFilterCard
      icon={
        filter.kind === "thread" ? (
          <img
            className="pult-card-icon"
            src={projectIconUri(filter.project).toString(true)}
            alt=""
          />
        ) : (
          <i className="pult-card-icon codicon codicon-root-folder" aria-hidden />
        )
      }
      top={filter.kind === "thread" ? filter.project.name : filter.environment}
      title={
        filter.kind === "thread" ? (filter.threadTitle ?? "New thread") : toHostPath(filter.path)
      }
      tooltip={`Only ${filter.path}`}
      clearTitle="Clear the filter: show the environments' projects"
      onClear={() => runCommand("pult-shell.openEnvironmentExplorer")}
    />
  );
}

/** A view's tree, as far as the card needs it: its public layout and the scroll events that report its height. */
interface ViewTree {
  layout(height: number, width?: number): void;
  onDidScroll(
    listener: (event: { readonly height: number; readonly heightChanged: boolean }) => void,
  ): IDisposable;
}

/** A view's tree, its field `tree`; undefined if a workbench bump renames it, and the card then costs the tree its bottom. */
function viewTree(view: unknown): ViewTree | undefined {
  if (typeof view !== "object" || view === null || !("tree" in view)) return undefined;
  const { tree } = view;
  if (typeof tree !== "object" || tree === null || !("layout" in tree) || !("onDidScroll" in tree))
    return undefined;
  return tree as ViewTree;
}

/**
 * Puts `card` in the view `viewId`, before its tree's element (`selector`),
 * each time the view shows: a stock view has no slot for one, so the card is
 * an element of the shell's own in the view's body, which `panel.css` lays
 * out as a column. The view lays the tree out for its whole body, so the
 * tree and its element are laid out again for the height the card leaves,
 * whenever that height changes and whenever the view lays it out. A view
 * that recreates its tree's element (the explorer's, when its folders go
 * from none to some) gets the card moved to the new one.
 */
export async function mountViewCard(
  viewId: string,
  selector: string,
  card: ReactNode,
): Promise<void> {
  const views = await getService(IViewsService);
  let mounted:
    | { readonly container: HTMLElement; readonly root: Root; readonly dispose: () => void }
    | undefined;
  const mount = () => {
    const container = document.querySelector<HTMLElement>(selector);
    if (container === null || mounted?.container === container) return;
    mounted?.dispose();
    const host = document.createElement("div");
    host.className = "pult-view-filter";
    container.before(host);
    const root = createRoot(host);
    root.render(card);
    const tree = viewTree(views.getViewWithId(viewId));
    const available = () => (host.parentElement?.clientHeight ?? 0) - host.offsetHeight;
    const fit = () => {
      const height = available();
      if (height <= 0) return;
      // Source Control sets its tree's element's height inline.
      container.style.height = `${height}px`;
      tree?.layout(height);
    };
    // After the view's own layout has finished, which reports the body's height.
    const relayout = tree?.onDidScroll(({ height, heightChanged }) => {
      if (heightChanged && height !== available()) queueMicrotask(fit);
    });
    const resize = new ResizeObserver(fit);
    resize.observe(host);
    if (host.parentElement !== null) resize.observe(host.parentElement);
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
    if (id === viewId && visible) mount();
  });
  mount();
}

/** The Explorer tab's filter card (`ExplorerCard`). */
export function mountFilterCard(): Promise<void> {
  return mountViewCard(FILE_VIEW_ID, ".part.sidebar .explorer-folders-view", <ExplorerCard />);
}
