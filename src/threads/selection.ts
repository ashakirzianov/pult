import {
  getService,
  type IEditorGroup,
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  IStorageService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { StorageScope, StorageTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { GroupsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { ThreadInput } from "./pane.tsx";
import { threadStore } from "./store.ts";

/** The thread whose tabs the editor part shows, in the environment it belongs to. */
export interface ThreadSelection {
  readonly environmentId: string;
  readonly threadId: string;
}

const STORAGE_KEY = "pult.shell.selectedThread";

let selected: ThreadSelection | undefined;
let switching = false;
let queue = Promise.resolve();
const listeners = new Set<() => void>();

export function selectedThread(): ThreadSelection | undefined {
  return selected;
}

/** True while a switch swaps the editor part, whose editor events are transient then. */
export function isSwitchingThread(): boolean {
  return switching;
}

/** Called after every completed selection, the startup one included. */
export function onDidSelectThread(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Selects a thread: the editor part becomes that thread's tab set. The
 * previous thread's tabs are kept as an editor working set (the workbench's
 * own save-and-apply of the editor part, which serialises every input and
 * group and persists in workspace storage), named by environment and thread;
 * the next thread's working set is applied, or an empty part, and its thread
 * tab is opened leftmost in the first group if missing. Switches run one at a
 * time, in call order.
 */
export function selectThread(threadId: string): Promise<void> {
  const next = queue.then(() => switchTo(threadId));
  queue = next.catch(() => undefined);
  return next;
}

async function switchTo(threadId: string): Promise<void> {
  const environmentId = threadStore.get().environment?.id;
  if (environmentId === undefined) throw new Error("Connect to an environment before selecting a thread.");
  const next = { environmentId, threadId };
  const groups = await getService(IEditorGroupsService);
  const storage = await getService(IStorageService);
  const instantiation = await getService(IInstantiationService);

  switching = true;
  try {
    // With nothing selected yet, the open editors become the new thread's tabs.
    if (selected !== undefined && workingSetName(selected) !== workingSetName(next)) {
      deleteWorkingSet(selected);
      groups.saveWorkingSet(workingSetName(selected));
      const saved = groups.getWorkingSets().find((set) => set.name === workingSetName(next));
      await groups.applyWorkingSet(saved ?? "empty", { preserveFocus: true });
    }
    selected = next;
    storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    await showThreadTab(threadId);
  } finally {
    switching = false;
  }
  for (const listener of listeners) listener();

  /** The thread's tab in the first group, leftmost; other threads' tabs leave. */
  async function showThreadTab(id: string): Promise<void> {
    for (const group of groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      const stale = group.editors.filter((editor) => editor instanceof ThreadInput && editor.threadId !== id);
      if (stale.length > 0) await group.closeEditors(stale, { force: true });
    }
    const first = groups.getGroups(GroupsOrder.GRID_APPEARANCE)[0] ?? groups.activeGroup;
    if (!first.editors.some((editor) => editor instanceof ThreadInput)) {
      await first.openEditor(instantiation.createInstance(ThreadInput, id), { pinned: true, index: 0 });
    }
    keepThreadTabsFirst(groups.getGroups(GroupsOrder.GRID_APPEARANCE));
  }

  function deleteWorkingSet(selection: ThreadSelection): void {
    for (const set of groups.getWorkingSets()) {
      if (set.name === workingSetName(selection)) groups.deleteWorkingSet(set);
    }
  }
}

function workingSetName({ environmentId, threadId }: ThreadSelection): string {
  return `pult.thread/${environmentId}/${threadId}`;
}

/**
 * Moves a thread tab back to the left edge of its group. Not sticky: a sticky
 * tab offers an unpin button, and a dragged editor can still land before it,
 * so the shell puts it back after every change instead.
 */
function keepThreadTabsFirst(groups: ReadonlyArray<IEditorGroup>): void {
  for (const group of groups) {
    const tab = group.editors.find((editor) => editor instanceof ThreadInput);
    if (tab !== undefined && group.getIndexOfEditor(tab) !== 0) {
      group.moveEditor(tab, group, { index: 0 });
    }
  }
}

/**
 * Reads the selection saved before a reload; the editor part restores its own
 * state, which is the selected thread's tabs, so nothing is applied. Then
 * keeps the thread tab leftmost as editors move, after each change has settled:
 * the event fires inside a group's move, before its tab strip has caught up,
 * and a second move from there scrambles the strip's labels. Started once the
 * workbench is up.
 */
export async function restoreThreadSelection(): Promise<void> {
  const storage = await getService(IStorageService);
  const saved = storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
  if (saved !== undefined) selected = JSON.parse(saved) as ThreadSelection;
  const groups = await getService(IEditorGroupsService);
  const editors = await getService(IEditorService);
  editors.onDidEditorsChange(() => {
    if (!switching) queueMicrotask(() => keepThreadTabsFirst(groups.groups));
  });
  for (const listener of listeners) listener();
}

/** `pult-shell.selectThread [threadId]`: with no id, a quick pick of the environment's threads. */
export function registerSelectThreadCommand(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectThread",
          title: { value: "Select Thread", original: "Select Thread" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      async run(accessor: ServicesAccessor, threadId?: unknown): Promise<void> {
        if (typeof threadId === "string") return selectThread(threadId);
        // Services are read before any await; the accessor is only valid synchronously.
        const quickInput = accessor.get(IQuickInputService);
        const items = threadStore.get().threads.map((thread) => ({
          id: thread.id,
          label: thread.title,
          description: thread.projectName,
        }));
        const picked = await quickInput.pick(items, {
          placeHolder: "Select a thread",
          activeItem: items.find((item) => item.id === selected?.threadId),
        });
        if (picked !== undefined) await selectThread(picked.id);
      }
    },
  );
}
