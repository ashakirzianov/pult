import {
  getService,
  ICommandService,
  IContextKeyService,
  ILifecycleService,
  INotificationService,
  IPaneCompositePartService,
  IStorageService,
  IViewDescriptorService,
  IWorkspaceContextService,
  IWorkspaceEditingService,
} from "@codingame/monaco-vscode-api";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { StorageScope, StorageTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { LifecyclePhase } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/lifecycle/common/lifecycle";
import { request } from "@t3tools/client-runtime/rpc";
import { type ProjectIconOverride, WS_METHODS } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { namesEnvironment, PULT_SCHEME, relativeTo, toUriPath } from "../files/paths.ts";
import { whenReady } from "../files/server.ts";
import { type DraftSelection, onDidSelectThread, selectedDraft, selectedThread, type ThreadSelection } from "../threads/selection.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";

/** The panel's own view container, and its one view, in the sidebar: the Threads tab. */
export const PANEL_ID = "pult.panel";
const EXPLORER_ID = "workbench.view.explorer";
const FILE_VIEW_ID = "workbench.explorer.fileView";
/** The explorer container's other views, which the Explorer tab does not show. */
const HIDDEN_VIEW_IDS = ["outline", "timeline", "workbench.explorer.openEditorsView"];

/**
 * What the Explorer tab is rooted at, as the user chose it: the selected
 * thread's root alone, shown as a card above the tree that clears it, or
 * each held environment's home directory. Kept in workspace storage;
 * `thread` until the user clears it.
 */
type Scope = "thread" | "environment";
const SCOPE_STORAGE_KEY = "pult.shell.explorerScope";
let scope: Scope = "thread";

/** The scope in effect, `environment` while the scope's thread has no root: the toggle's state. */
const ScopeContext = new RawContextKey<Scope>("pult.explorerScope", "environment");
/** Whether the scope's thread has a root to narrow to: the toggle's precondition. */
const ThreadHasFolderContext = new RawContextKey<boolean>("pult.threadHasFolder", false);

/** The thread or draft selected last; it stays the scope's while Settings is selected. */
let lastSelected: ThreadSelection | DraftSelection | undefined;

interface Folder {
  readonly uri: URI;
  readonly name: string;
}

/** The Threads tab. */
export async function showThreads(): Promise<void> {
  await (await getService(IPaneCompositePartService)).openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar, true);
}

/**
 * The Explorer tab, narrowed to the selected thread's root: the root is the
 * workspace's only folder then, as the explorer shows the workspace's folders
 * and the page's `pult:` provider serves them (`src/files/`). A thread with no project
 * root cannot narrow; its card says so.
 */
export async function openThreadExplorer(): Promise<void> {
  if (threadRootOfScope() === undefined) {
    (await getService(INotificationService)).info("Pult: the selected thread has no project folder to explore.");
    return;
  }
  await openExplorer("thread");
}

/** The Explorer tab at every held environment's home directory: the filter's card clears to it. */
export function openEnvironmentExplorer(): Promise<void> {
  return openExplorer("environment");
}

/** Flips the scope in effect, and shows the Explorer tab. */
export function toggleExplorerScope(): Promise<void> {
  return effectiveRoot() === undefined ? openThreadExplorer() : openEnvironmentExplorer();
}

/** Sets the scope and its folders, then shows the Explorer tab; a failure, already notified, leaves the scope as it was. */
async function openExplorer(next: Scope): Promise<void> {
  const previous = scope;
  await setScope(next);
  if (!(await reroot())) {
    if (scope === next) await setScope(previous);
    return;
  }
  if (scope !== next) return;
  await (await getService(IPaneCompositePartService)).openPaneComposite(EXPLORER_ID, ViewContainerLocation.Sidebar, true);
}

async function setScope(next: Scope): Promise<void> {
  scope = next;
  (await getService(IStorageService)).store(SCOPE_STORAGE_KEY, next, StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/** The thread's own root: its project's, since the store carries no worktree yet. */
function threadFolder(thread: ShellThread): Folder | undefined {
  if (thread.projectRoot === null) return undefined;
  return { uri: pultUri(thread.environmentId, thread.projectRoot), name: thread.projectName };
}

/** Each environment's home directory, as its server resolves `~/` once connected; a failed lookup is asked again next time. */
const homes = new Map<string, Promise<string>>();

function homeOf(environmentId: string): Promise<string> {
  let home = homes.get(environmentId);
  if (home === undefined) {
    home = whenReady(environmentId)
      .then(() => connection.run(environmentId, request(WS_METHODS.filesystemBrowse, { partialPath: "~/" })))
      .then(({ parentPath }) => parentPath);
    home.catch(() => homes.delete(environmentId));
    homes.set(environmentId, home);
  }
  return home;
}

/** The environment's home as a folder, `~`, named with its environment's label too while the page holds several. */
async function homeFolder(environmentId: string): Promise<Folder> {
  const label = threadStore.distinguishing(environmentId);
  return { uri: pultUri(environmentId, await homeOf(environmentId)), name: label === undefined ? "~" : `~ (${label})` };
}

/** Whether `uri` is `root` or under it, on the same environment. */
function within(uri: URI, root: URI): boolean {
  return uri.scheme === root.scheme && namesEnvironment(uri.authority, root.authority) && relativeTo(root.path, uri.path) !== undefined;
}

/**
 * The root of the scope's thread, the selected one, in its environment, or
 * for a draft of a new thread its project's; undefined for none, a thread
 * gone, or one of an environment the page no longer holds.
 */
function threadRootOfScope(): Folder | undefined {
  if (lastSelected === undefined) return undefined;
  const { environmentId } = lastSelected;
  if ("projectId" in lastSelected) {
    const project = threadStore.project(environmentId, lastSelected.projectId);
    return project?.root == null ? undefined : { uri: pultUri(environmentId, project.root), name: project.name };
  }
  const thread = threadStore.thread(environmentId, lastSelected.threadId);
  return thread === undefined ? undefined : threadFolder(thread);
}

/** The one root the folders narrow to, or undefined for the environment's: the thread scope falls back to it while its thread has no root. */
function effectiveRoot(): Folder | undefined {
  return scope === "thread" ? threadRootOfScope() : undefined;
}

/** A host path as a `pult:` URI, as the page's provider serves it (`src/files/`). */
export function pultUri(environmentId: string, hostPath: string): URI {
  return URI.from({ scheme: PULT_SCHEME, authority: environmentId, path: toUriPath(hostPath) });
}

/** A folder's identity: the URI's string form, which lowercases the authority as stored folders have it. */
const keyOf = (uri: URI) => uri.toString();

let rerooting = Promise.resolve(true);
/** True while `reroot` changes the folders, so a change from elsewhere tells itself apart. */
let updating = false;
/** Sets the context keys and the filter to the scope in effect; set once the workbench is up. */
let updateContextKeys = () => {};

/**
 * Sets the workspace folders to the scope's, one update at a time: each reads
 * the scope and the folders when its turn comes, after the previous update
 * has landed. The thread scope narrows them to the selected thread's root;
 * the environment scope, and the thread scope of a thread without one, set
 * each held environment's home directory, keeping a folder of the held
 * environments already there outside its home (one "Pult: Open Project"
 * added), or all of its folders while its home cannot be had; a home is
 * renamed as the number of environments makes its name carry its
 * environment's or not. Before the restored selection is known, the thread
 * scope leaves the folders as they are. A failure is notified. Resolves to
 * whether the folders are the scope's.
 */
function reroot(): Promise<boolean> {
  rerooting = rerooting.then(update).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(`Pult could not set the explorer's folders: ${message}`);
    return false;
  });
  return rerooting;

  async function update(): Promise<boolean> {
    updateContextKeys();
    const { environments } = threadStore.get();
    // Nothing to narrow to until the restored selection is known: the folders stay as the workspace kept them.
    if (environments.length === 0 || (scope === "thread" && lastSelected === undefined)) return true;
    const root = effectiveRoot();
    const current = (await getService(IWorkspaceContextService)).getWorkspace().folders;
    const wanted = new Map<string, Folder>();
    // The thread's root keeps its folder, and its tree, under whichever name it has.
    if (root !== undefined) wanted.set(keyOf(root.uri), current.find((folder) => keyOf(folder.uri) === keyOf(root.uri)) ?? root);
    else {
      // An environment whose home cannot be had (offline, its server not answering) keeps its folders as they are.
      const homeFolders = (await Promise.all(environments.map((environment) => homeFolder(environment.id).catch(() => undefined)))).filter(
        (home) => home !== undefined,
      );
      for (const home of homeFolders) wanted.set(keyOf(home.uri), home);
      const held = new Set(environments.map((environment) => environment.id.toLowerCase()));
      for (const folder of current) {
        if (folder.uri.scheme !== PULT_SCHEME || !held.has(folder.uri.authority.toLowerCase())) continue;
        if (!homeFolders.some((home) => within(folder.uri, home.uri))) wanted.set(keyOf(folder.uri), folder);
      }
    }
    // A folder kept under another name is replaced.
    const renamed = (folder: Folder) => {
      const next = wanted.get(keyOf(folder.uri));
      return next !== undefined && next.name !== folder.name;
    };
    const present = new Map(current.map((folder) => [keyOf(folder.uri), folder]));
    const remove = current.filter((folder) => !wanted.has(keyOf(folder.uri)) || renamed(folder)).map((folder) => folder.uri);
    const add = [...wanted.entries()].flatMap(([key, folder]) => {
      const existing = present.get(key);
      return existing === undefined || renamed(existing) ? [folder] : [];
    });
    const editing = await getService(IWorkspaceEditingService);
    updating = true;
    try {
      // Replacing every folder is one update; a folder kept stays in place, its tree as it was.
      if (add.length > 0 && remove.length === current.length) await editing.updateFolders(0, current.length, add, true);
      else {
        if (remove.length > 0) await editing.removeFolders(remove, true);
        if (add.length > 0) await editing.addFolders(add, true);
      }
    } finally {
      updating = false;
    }
    return true;
  }
}

/**
 * Keeps the folders to the scope once the workbench is up. The scope follows
 * the selection, and a folder added from elsewhere while it is narrowed
 * widens it to the environment's and is revealed there. Every change to the
 * thread model re-roots, so a thread gone or rootless falls back to the
 * environment's, and the filter follows the root in effect. The Explorer tab, however
 * opened (Cmd+Shift+E, Reveal in Explorer, its tab), shows the scope as it is,
 * with the file view alone. Waits for the workbench to have restored its parts.
 */
export async function followExplorerScope(): Promise<void> {
  await (await getService(ILifecycleService)).when(LifecyclePhase.Restored);
  const stored = (await getService(IStorageService)).get(SCOPE_STORAGE_KEY, StorageScope.WORKSPACE);
  if (stored === "thread" || stored === "environment") scope = stored;
  const contextKeys = await getService(IContextKeyService);
  const scopeKey = ScopeContext.bindTo(contextKeys);
  const hasFolderKey = ThreadHasFolderContext.bindTo(contextKeys);
  updateContextKeys = () => {
    const root = effectiveRoot();
    scopeKey.set(root === undefined ? "environment" : "thread");
    hasFolderKey.set(threadRootOfScope() !== undefined);
    setFilter(root === undefined ? undefined : filterOfScope(root));
  };
  const viewDescriptors = await getService(IViewDescriptorService);
  const explorer = viewDescriptors.getViewContainerById(EXPLORER_ID);
  if (explorer !== null) {
    const model = viewDescriptors.getViewContainerModel(explorer);
    for (const id of HIDDEN_VIEW_IDS) model.setVisible(id, false);
  }
  const followSelection = () => {
    lastSelected = selectedThread() ?? selectedDraft() ?? lastSelected;
  };
  followSelection();
  onDidSelectThread(() => {
    followSelection();
    void reroot();
  });
  // A folder added from elsewhere ("Pult: Open Project") while the folders are narrowed widens the scope, and shows the folder, under its home if it is in one.
  const commands = await getService(ICommandService);
  (await getService(IWorkspaceContextService)).onDidChangeWorkspaceFolders(({ added }) => {
    const folder = added[0];
    if (updating || effectiveRoot() === undefined || folder === undefined) return;
    void setScope("environment")
      .then(reroot)
      .then((rerooted) => rerooted && commands.executeCommand("revealInExplorer", folder.uri));
  });
  threadStore.subscribe(() => void reroot());
  await reroot();
}

/**
 * What the filter's card shows while the folders are narrowed: the root's
 * project, with its icon, and the thread's title when a thread, not a
 * draft of a new one, narrowed them (`filterCard.tsx`).
 */
export interface ExplorerFilter {
  readonly projectName: string;
  readonly projectIcon: ProjectIconOverride | null;
  readonly threadTitle: string | undefined;
  /** The root's host path, for the card's hover. */
  readonly path: string;
}

let filter: ExplorerFilter | undefined;
const filterListeners = new Set<() => void>();

/** The filter in effect, for `useSyncExternalStore`: the same object until what it shows changes. */
export const explorerFilter = {
  get: () => filter,
  subscribe(listener: () => void): () => void {
    filterListeners.add(listener);
    return () => filterListeners.delete(listener);
  },
};

function setFilter(next: ExplorerFilter | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(filter)) return;
  filter = next;
  for (const listener of filterListeners) listener();
}

/** The filter for the scope's thread or draft, narrowed to `root`. */
function filterOfScope(root: Folder): ExplorerFilter {
  const path = root.uri.path;
  if (lastSelected !== undefined && "threadId" in lastSelected) {
    const thread = threadStore.thread(lastSelected.environmentId, lastSelected.threadId);
    if (thread !== undefined) return { projectName: thread.projectName, projectIcon: thread.projectIcon, threadTitle: thread.title, path };
  }
  const project = lastSelected !== undefined && "projectId" in lastSelected ? threadStore.project(lastSelected.environmentId, lastSelected.projectId) : undefined;
  return { projectName: project?.name ?? root.name, projectIcon: project?.icon ?? null, threadTitle: undefined, path };
}

/**
 * The panel's tab commands for the palette: `pult-shell.showThreads`, the
 * explorers' (the environment's also the filter's clear), and
 * `pult-shell.toggleExplorerScope`.
 */
export function registerExplorerCommands(): void {
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({ id: "pult-shell.showThreads", title: { value: "Show Threads", original: "Show Threads" }, category, f1: true });
      }

      run(): Promise<void> {
        return showThreads();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openThreadExplorer",
          title: { value: "Open Thread Explorer", original: "Open Thread Explorer" },
          category,
          f1: true,
        });
      }

      run(): Promise<void> {
        return openThreadExplorer();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openEnvironmentExplorer",
          title: { value: "Open Environment Explorer", original: "Open Environment Explorer" },
          category,
          f1: true,
        });
      }

      run(): Promise<void> {
        return openEnvironmentExplorer();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.toggleExplorerScope",
          title: { value: "Explorer: Only This Thread's Folder", original: "Explorer: Only This Thread's Folder" },
          category,
          toggled: ScopeContext.isEqualTo("thread"),
          f1: true,
          precondition: ThreadHasFolderContext,
        });
      }

      run(): Promise<void> {
        return toggleExplorerScope();
      }
    },
  );
}
