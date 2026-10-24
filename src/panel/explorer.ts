import {
  getService,
  ILifecycleService,
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
 * folders, and the extension's `pult:` provider serves them.
 */
export async function openThreadExplorer(threadId: string): Promise<void> {
  mode = { kind: "thread", threadId };
  await reroot();
  await (await getService(IPaneCompositePartService)).openPaneComposite(EXPLORER_ID, ViewContainerLocation.Sidebar, true);
}

/** The explorer at the environment's roots, as a multi-root. */
export async function openEnvironmentExplorer(): Promise<void> {
  mode = { kind: "environment" };
  await reroot();
  await (await getService(IPaneCompositePartService)).openPaneComposite(EXPLORER_ID, ViewContainerLocation.Sidebar, true);
}

/** Back to the cards; the folders return to the environment's roots, so files of any of them still save. */
export async function closeExplorer(): Promise<void> {
  await (await getService(IPaneCompositePartService)).openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar, true);
}

/** The thread's own root: its project's, since the store carries no worktree yet. */
function threadFolder(thread: ShellThread, environmentId: string): Folder | undefined {
  return thread.projectRoot === null ? undefined : { uri: pultUri(environmentId, thread.projectRoot), name: thread.projectName };
}

/** The environment's roots: the projects its threads run in, as the store reports them. */
function environmentFolders(): ReadonlyArray<Folder> {
  const { environment, threads } = threadStore.get();
  if (environment === null) return [];
  const folders = new Map<string, Folder>();
  for (const thread of threads) {
    const folder = threadFolder(thread, environment.id);
    if (folder !== undefined && !folders.has(folder.uri.path)) folders.set(folder.uri.path, folder);
  }
  return [...folders.values()];
}

/** A host path as a `pult:` URI, as the extension writes them: a Windows drive as `/c:/`. */
function pultUri(environmentId: string, hostPath: string): URI {
  const path = /^[A-Za-z]:/.test(hostPath)
    ? `/${hostPath.charAt(0).toLowerCase()}${hostPath.slice(1).replaceAll("\\", "/")}`
    : hostPath;
  return URI.from({ scheme: "pult", authority: environmentId, path });
}

/** Sets the workspace folders to the mode's roots, when they differ. */
async function reroot(): Promise<void> {
  const wanted = wantedFolders();
  if (wanted === undefined) return;
  const workspace = await getService(IWorkspaceContextService);
  const current = workspace.getWorkspace().folders;
  const same =
    current.length === wanted.length &&
    current.every((folder, index) => folder.uri.toString() === wanted[index]!.uri.toString());
  if (same) return;
  const editing = await getService(IWorkspaceEditingService);
  await editing.updateFolders(0, current.length, [...wanted], true);

  /** Undefined leaves the folders alone: no environment, or a thread with no root. */
  function wantedFolders(): ReadonlyArray<Folder> | undefined {
    const environment = threadStore.get().environment;
    if (environment === null) return undefined;
    if (mode.kind !== "thread") {
      const folders = environmentFolders();
      return folders.length === 0 ? undefined : folders;
    }
    const { threadId } = mode;
    const thread = threadStore.get().threads.find((candidate) => candidate.id === threadId);
    const folder = thread === undefined ? undefined : threadFolder(thread, environment.id);
    return folder === undefined ? undefined : [folder];
  }
}

/**
 * Follows the sidebar once the workbench is up. The stock explorer opened
 * any other way (Cmd+Shift+E, Reveal in Explorer) is the environment's; the
 * panel's container opened any way is the cards. A thread's explorer follows
 * the selection made elsewhere, and either explorer the thread model's roots.
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
  threadStore.subscribe(() => {
    if (mode.kind !== "cards") void reroot();
  });
  const active = paneComposites.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
  markCards(active);
  if (layout.isVisible(Parts.SIDEBAR_PART) && active !== PANEL_ID) {
    await paneComposites.openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar);
  }
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
