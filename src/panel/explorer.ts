import {
  getService,
  IContextKeyService,
  ILifecycleService,
  INotificationService,
  IPaneCompositePartService,
  IStorageService,
  IViewDescriptorService,
  IWorkspaceContextService,
  IWorkspaceEditingService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { StorageScope, StorageTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { LifecyclePhase } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/lifecycle/common/lifecycle";

import { PULT_SCHEME, toUriPath } from "../files/paths.ts";
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
 * thread's root alone, or every root of the environment. Kept in workspace
 * storage; `thread` until the user widens it.
 */
type Scope = "thread" | "environment";
const SCOPE_STORAGE_KEY = "pult.shell.explorerScope";
let scope: Scope = "thread";

/** The scope in effect, `environment` while the scope's thread has no root: the toggle's state. */
const ScopeContext = new RawContextKey<Scope>("pult.explorerScope", "environment");
/** Whether the scope's thread has a root to narrow to: the toggle's and "Open explorer"'s precondition. */
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

/** The Explorer tab at the environment's roots, as a multi-root. */
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
function threadFolder(thread: ShellThread, environmentId: string): Folder | undefined {
  return thread.projectRoot === null ? undefined : { uri: pultUri(environmentId, thread.projectRoot), name: thread.projectName };
}

/**
 * The root of the scope's thread, the selected one, in the connected
 * environment, or for a draft of a new thread its project's; undefined for
 * none, or a thread gone.
 */
function threadRootOfScope(): Folder | undefined {
  const { environment, threads } = threadStore.get();
  if (environment === null || lastSelected === undefined) return undefined;
  if ("projectId" in lastSelected) {
    const project = threadStore.project(lastSelected.projectId);
    return project?.root == null ? undefined : { uri: pultUri(environment.id, project.root), name: project.name };
  }
  const { threadId } = lastSelected;
  const thread = threads.find((candidate) => candidate.id === threadId);
  return thread === undefined ? undefined : threadFolder(thread, environment.id);
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
/** Sets the context keys to the scope in effect; set once the workbench is up. */
let updateContextKeys = () => {};

/**
 * Sets the workspace folders to the scope's, one update at a time: each reads
 * the scope and the folders when its turn comes, after the previous update
 * has landed. The thread scope narrows them to the selected thread's root;
 * the environment scope, and the thread scope of a thread without one, keep
 * every folder of the environment already there (one "Pult: Open Project"
 * added) and add the threads' roots, never removing one.
 * A failure is notified. Resolves to whether the folders are the scope's.
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
    const { environment, threads } = threadStore.get();
    if (environment === null) return true;
    const root = effectiveRoot();
    const current = (await getService(IWorkspaceContextService)).getWorkspace().folders;
    const wanted = new Map<string, Folder>();
    if (root !== undefined) wanted.set(keyOf(root.uri), root);
    else {
      const environmentId = environment.id.toLowerCase();
      for (const folder of current) {
        if (folder.uri.scheme === PULT_SCHEME && folder.uri.authority.toLowerCase() === environmentId) wanted.set(keyOf(folder.uri), folder);
      }
      for (const thread of threads) {
        const folder = threadFolder(thread, environment.id);
        if (folder !== undefined && !wanted.has(keyOf(folder.uri))) wanted.set(keyOf(folder.uri), folder);
      }
    }
    const present = new Set(current.map((folder) => keyOf(folder.uri)));
    const remove = current.filter((folder) => !wanted.has(keyOf(folder.uri))).map((folder) => folder.uri);
    const add = [...wanted.entries()].filter(([key]) => !present.has(key)).map(([, folder]) => folder);
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
 * widens it to the environment's. Every change to the thread model re-roots,
 * so the folders hold the threads' roots whichever tab shows, and a thread
 * gone or rootless falls back to the environment's. The Explorer tab, however
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
    scopeKey.set(effectiveRoot() === undefined ? "environment" : "thread");
    hasFolderKey.set(threadRootOfScope() !== undefined);
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
  // A folder added from elsewhere ("Pult: Open Project") while the folders are narrowed widens the scope.
  (await getService(IWorkspaceContextService)).onDidChangeWorkspaceFolders(({ added }) => {
    if (updating || effectiveRoot() === undefined || added.length === 0) return;
    void setScope("environment").then(reroot);
  });
  threadStore.subscribe(() => void reroot());
  await reroot();
}

/**
 * The panel's tab commands for the palette: `pult-shell.showThreads`, the
 * explorers', and `pult-shell.toggleExplorerScope`, also the toggle in the
 * Explorer tab's title, a filled filter while the folders are narrowed.
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
          tooltip: "Only this thread's folder",
          category,
          icon: Codicon.filter,
          toggled: {
            condition: ScopeContext.isEqualTo("thread"),
            icon: Codicon.filterFilled,
            tooltip: "Only this thread's folder: on. Show every folder of the environment",
          },
          f1: true,
          precondition: ThreadHasFolderContext,
          menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals("view", FILE_VIEW_ID), group: "navigation", order: 100 },
        });
      }

      run(): Promise<void> {
        return toggleExplorerScope();
      }
    },
  );
}
