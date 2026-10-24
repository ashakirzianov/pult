import {
  getService,
  ILifecycleService,
  INotificationService,
  IPaneCompositePartService,
  IViewDescriptorService,
  IWorkbenchLayoutService,
  IWorkspaceContextService,
  IWorkspaceEditingService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { LifecyclePhase } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/lifecycle/common/lifecycle";

import { onDidSelectThread, selectedThread } from "../threads/selection.ts";
import { type ShellThread, threadStore } from "../threads/store.ts";

/** The panel's own view container, and its one view, in the sidebar. */
export const PANEL_ID = "pult.panel";
const EXPLORER_ID = "workbench.view.explorer";
const FILE_VIEW_ID = "workbench.explorer.fileView";
/** The explorer container's other views, which the panel's explorer does not show. */
const HIDDEN_VIEW_IDS = ["outline", "timeline", "workbench.explorer.openEditorsView"];

/**
 * What the sidebar shows: the panel's cards, or VS Code's stock explorer
 * container swapped in, rooted at a thread's root or at the environment's.
 */
type Mode = { readonly kind: "cards" } | { readonly kind: "thread"; readonly threadId: string } | { readonly kind: "environment" };

let mode: Mode = { kind: "cards" };

interface Folder {
  readonly uri: URI;
  readonly name: string;
}

/**
 * The explorer at the thread's root, in place of the cards. The root is the
 * workspace's only folder while it shows: the explorer shows the workspace's
 * folders, and the extension's `pult:` provider serves them. A thread with no
 * project root has no explorer; its card says so.
 */
export async function openThreadExplorer(threadId: string): Promise<void> {
  if (threadRoot(threadId) === undefined) {
    (await getService(INotificationService)).info("Pult: this thread has no project folder to explore.");
    return;
  }
  await openExplorer({ kind: "thread", threadId });
}

/** The explorer at the environment's roots, as a multi-root. */
export function openEnvironmentExplorer(): Promise<void> {
  return openExplorer({ kind: "environment" });
}

/** Sets the folders for `next`, then shows the explorer; a failure, already notified, leaves the sidebar as it was. */
async function openExplorer(next: Mode): Promise<void> {
  const previous = mode;
  mode = next;
  if (!(await reroot())) {
    if (mode === next) mode = previous;
    return;
  }
  if (mode !== next) return;
  await (await getService(IPaneCompositePartService)).openPaneComposite(EXPLORER_ID, ViewContainerLocation.Sidebar, true);
}

/** Back to the cards; the folders widen to the environment's again, so files of any of its roots still save. */
export async function closeExplorer(): Promise<void> {
  await (await getService(IPaneCompositePartService)).openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar, true);
}

/** The thread's own root: its project's, since the store carries no worktree yet. */
function threadFolder(thread: ShellThread, environmentId: string): Folder | undefined {
  return thread.projectRoot === null ? undefined : { uri: pultUri(environmentId, thread.projectRoot), name: thread.projectName };
}

/** The root of a thread of the connected environment; undefined for none, or a thread gone. */
function threadRoot(threadId: string): Folder | undefined {
  const { environment, threads } = threadStore.get();
  const thread = threads.find((candidate) => candidate.id === threadId);
  return environment === null || thread === undefined ? undefined : threadFolder(thread, environment.id);
}

/**
 * A host path as a `pult:` URI, by the rules of the extension's `toUriPath`
 * (keep the two in step): a Windows drive as `/c:/`, and no trailing slash
 * but the root's or a drive's, as the workbench strips it from a folder.
 */
function pultUri(environmentId: string, hostPath: string): URI {
  const drive = /^[A-Za-z]:([\\/]|$)/.test(hostPath)
    ? `/${hostPath.charAt(0).toLowerCase()}${hostPath.slice(1).replaceAll("\\", "/")}`
    : hostPath;
  const path = drive.length > 1 && drive.endsWith("/") && !/^\/[A-Za-z]:\/$/.test(drive) ? drive.slice(0, -1) : drive;
  return URI.from({ scheme: "pult", authority: environmentId, path });
}

/** A folder's identity: the URI's string form, which lowercases the authority as stored folders have it. */
const keyOf = (uri: URI) => uri.toString();

let rerooting = Promise.resolve(true);
/** True while `reroot` changes the folders, so a change from elsewhere tells itself apart. */
let updating = false;

/**
 * Sets the workspace folders to the mode's, one update at a time: each reads
 * the mode and the folders when its turn comes, after the previous update has
 * landed. A thread's explorer narrows them to the thread's root; the cards and
 * the environment's explorer keep every folder of the environment already
 * there (one the extension added, as "Pult: Open Project" does) and add the
 * threads' roots, never removing one. A thread gone or rootless sends its
 * explorer back to the cards. A failure is notified. Resolves to whether the
 * folders are the mode's.
 */
function reroot(): Promise<boolean> {
  rerooting = rerooting.then(update).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(`Pult could not set the explorer's folders: ${message}`);
    return false;
  });
  return rerooting;

  async function update(): Promise<boolean> {
    const { environment, threads } = threadStore.get();
    if (environment === null) return true;
    const root = mode.kind === "thread" ? threadRoot(mode.threadId) : undefined;
    if (mode.kind === "thread" && root === undefined) {
      mode = { kind: "cards" };
      await closeExplorer();
    }
    const current = (await getService(IWorkspaceContextService)).getWorkspace().folders;
    const wanted = new Map<string, Folder>();
    if (root !== undefined) wanted.set(keyOf(root.uri), root);
    else {
      const environmentId = environment.id.toLowerCase();
      for (const folder of current) {
        if (folder.uri.scheme === "pult" && folder.uri.authority.toLowerCase() === environmentId) wanted.set(keyOf(folder.uri), folder);
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
 * Follows the sidebar once the workbench is up. The stock explorer opened
 * any other way (Cmd+Shift+E, Reveal in Explorer) is the environment's; the
 * panel's container opened any way is the cards. A thread's explorer follows
 * the selection made elsewhere, and becomes the environment's when a folder
 * is added from elsewhere. Every change to the thread model re-roots,
 * the cards included, so a file of any root saves without an explorer opened.
 * The explorer container shows the file view alone, and the sidebar starts on
 * the cards: an explorer restored from before a reload has lost its root.
 * Waits for the workbench to have restored its parts.
 */
export async function followSidebar(): Promise<void> {
  await (await getService(ILifecycleService)).when(LifecyclePhase.Restored);
  const paneComposites = await getService(IPaneCompositePartService);
  const viewDescriptors = await getService(IViewDescriptorService);
  const explorer = viewDescriptors.getViewContainerById(EXPLORER_ID);
  if (explorer !== null) {
    const model = viewDescriptors.getViewContainerModel(explorer);
    for (const id of HIDDEN_VIEW_IDS) model.setVisible(id, false);
  }
  const layout = await getService(IWorkbenchLayoutService);
  // `panel.css` puts the logo in the sidebar's title row while the cards show.
  const markCards = (id: string | undefined) =>
    layout.getContainer(window, Parts.SIDEBAR_PART)?.classList.toggle("pult-panel-cards-shown", id === PANEL_ID);
  paneComposites.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => {
    if (viewContainerLocation !== ViewContainerLocation.Sidebar) return;
    const id = composite.getId();
    markCards(id);
    if (id === EXPLORER_ID && mode.kind === "cards") mode = { kind: "environment" };
    else if (id === PANEL_ID && mode.kind !== "cards") mode = { kind: "cards" };
    else return;
    void reroot();
  });
  onDidSelectThread(() => {
    const thread = selectedThread();
    if (mode.kind !== "thread" || thread === undefined || thread.threadId === mode.threadId) return;
    mode = { kind: "thread", threadId: thread.threadId };
    void reroot();
  });
  // A folder added from elsewhere ("Pult: Open Project") while a thread's explorer shows makes it the environment's.
  (await getService(IWorkspaceContextService)).onDidChangeWorkspaceFolders(({ added }) => {
    if (updating || mode.kind !== "thread" || added.length === 0) return;
    mode = { kind: "environment" };
    void reroot();
  });
  threadStore.subscribe(() => void reroot());
  const active = paneComposites.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
  markCards(active);
  if (layout.isVisible(Parts.SIDEBAR_PART) && active !== PANEL_ID) {
    await paneComposites.openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar);
  }
  await reroot();
}

/** `pult-shell.closeExplorer`, the X in the explorer's title; the explorers' commands for the palette. */
export function registerExplorerCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.closeExplorer",
          title: { value: "Close Explorer", original: "Close Explorer" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.close,
          f1: true,
          precondition: ContextKeyExpr.equals("activeViewlet", EXPLORER_ID),
          menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals("view", FILE_VIEW_ID), group: "navigation", order: 100 },
        });
      }

      run(): Promise<void> {
        return closeExplorer();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openThreadExplorer",
          title: { value: "Open Thread Explorer", original: "Open Thread Explorer" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(_accessor: unknown, threadId?: unknown): Promise<void> {
        const id = typeof threadId === "string" ? threadId : selectedThread()?.threadId;
        return id === undefined ? Promise.resolve() : openThreadExplorer(id);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openEnvironmentExplorer",
          title: { value: "Open Environment Explorer", original: "Open Environment Explorer" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(): Promise<void> {
        return openEnvironmentExplorer();
      }
    },
  );
}
