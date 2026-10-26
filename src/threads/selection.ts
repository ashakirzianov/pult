import {
  getService,
  ICommandService,
  type IEditorGroup,
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  IStorageService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry, type ICommandHandler } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
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

/** Settings, content of its own beside the threads: VS Code's settings editor with a tab set of its own. */
const SETTINGS = "settings";
type Selection = ThreadSelection | typeof SETTINGS;

const STORAGE_KEY = "pult.shell.selectedThread";

let selected: Selection | undefined;
let switching = false;
let queue = Promise.resolve();
const listeners = new Set<() => void>();

/** The selected thread; undefined while Settings is selected. */
export function selectedThread(): ThreadSelection | undefined {
  return selected === SETTINGS ? undefined : selected;
}

export function isSettingsSelected(): boolean {
  return selected === SETTINGS;
}

/** True while a switch swaps the editor part, whose editor events are transient then. */
export function isSwitchingThread(): boolean {
  return switching;
}

/** Called after every completed selection, the startup one and Settings included. */
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
  return enqueue(() => {
    const environmentId = threadStore.get().environment?.id;
    if (environmentId === undefined) throw new Error("Connect to an environment before selecting a thread.");
    return switchTo({ environmentId, threadId });
  });
}

/**
 * Selects Settings as a thread is selected: the selected thread's tabs are
 * saved, and the editor part shows Settings' own tab set, the settings editor
 * alone the first time. Selecting a thread again restores that thread's tabs.
 */
export function selectSettings(): Promise<void> {
  return enqueue(() => switchTo(SETTINGS));
}

function enqueue(run: () => Promise<void>): Promise<void> {
  const next = queue.then(run);
  queue = next.catch(() => undefined);
  return next;
}

async function switchTo(next: Selection): Promise<void> {
  const groups = await getService(IEditorGroupsService);
  const storage = await getService(IStorageService);
  const instantiation = await getService(IInstantiationService);
  const commands = await getService(ICommandService);

  switching = true;
  try {
    // With nothing selected yet, the open editors become the new selection's tabs.
    if (selected !== undefined && workingSetName(selected) !== workingSetName(next)) {
      deleteWorkingSet(selected);
      groups.saveWorkingSet(workingSetName(selected));
      const saved = groups.getWorkingSets().find((set) => set.name === workingSetName(next));
      await groups.applyWorkingSet(saved ?? "empty", { preserveFocus: true });
    }
    selected = next;
    storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    if (next === SETTINGS) await showSettings();
    else await showThreadTab(next.threadId);
  } finally {
    switching = false;
  }
  for (const listener of listeners) listener();

  /** The thread's tab in the first group, leftmost; other threads' tabs leave. */
  async function showThreadTab(id: string): Promise<void> {
    await closeThreadTabs((editor) => editor.threadId !== id);
    const first = groups.getGroups(GroupsOrder.GRID_APPEARANCE)[0] ?? groups.activeGroup;
    if (!first.editors.some((editor) => editor instanceof ThreadInput)) {
      await first.openEditor(instantiation.createInstance(ThreadInput, id), { pinned: true, index: 0 });
    }
    keepThreadTabsFirst(groups.getGroups(GroupsOrder.GRID_APPEARANCE));
  }

  /** No thread tab, and the settings editor open; Settings' working set may hold it already. */
  async function showSettings(): Promise<void> {
    await closeThreadTabs(() => true);
    await commands.executeCommand("workbench.action.openSettings2");
  }

  async function closeThreadTabs(stale: (editor: ThreadInput) => boolean): Promise<void> {
    for (const group of groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      const closing = group.editors.filter((editor) => editor instanceof ThreadInput && stale(editor));
      if (closing.length > 0) await group.closeEditors(closing, { force: true });
    }
  }

  function deleteWorkingSet(selection: Selection): void {
    for (const set of groups.getWorkingSets()) {
      if (set.name === workingSetName(selection)) groups.deleteWorkingSet(set);
    }
  }
}

function workingSetName(selection: Selection): string {
  return selection === SETTINGS ? "pult.settings" : `pult.thread/${selection.environmentId}/${selection.threadId}`;
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
  if (saved !== undefined) selected = JSON.parse(saved) as Selection;
  const groups = await getService(IEditorGroupsService);
  const editors = await getService(IEditorService);
  editors.onDidEditorsChange(() => {
    if (!switching) queueMicrotask(() => keepThreadTabsFirst(groups.groups));
  });
  for (const listener of listeners) listener();
}

/**
 * `pult-shell.selectThread [threadId]`: with no id, a quick pick of the
 * environment's threads. `pult-shell.selectSettings`, on Cmd+, over the
 * workbench's own binding, which would open the settings editor under the
 * thread; and the workbench's own Settings command routed the same way.
 */
export function registerSelectThreadCommand(): void {
  routeOpenSettings();
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
          activeItem: items.find((item) => item.id === selectedThread()?.threadId),
        });
        if (picked !== undefined) await selectThread(picked.id);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectSettings",
          title: { value: "Show Settings", original: "Show Settings" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          keybinding: { primary: KeyMod.CtrlCmd | KeyCode.Comma, weight: KeybindingWeight.WorkbenchContrib + 1 },
        });
      }

      run(): Promise<void> {
        return selectSettings();
      }
    },
  );
}

/**
 * `workbench.action.openSettings`, the stock Settings (the activity bar's
 * Manage menu, the palette's "Preferences: Open Settings", the links that
 * open a setting by query), selects Settings first: left alone it would open
 * the settings editor among the selected thread's tabs. The stock handler
 * then runs with the arguments, so a query or the JSON editor still reach it.
 * The stock command registers when the preferences contribution starts, after
 * the shell's registrations, and the registry's latest registration wins, so
 * the route goes on top of it then, and again if it is ever registered anew.
 */
function routeOpenSettings(): void {
  const id = "workbench.action.openSettings";
  let stock: ICommandHandler | undefined;
  const route: ICommandHandler = async (accessor, ...args) => {
    // Services are read before any await; the accessor is only valid synchronously.
    const instantiation = accessor.get(IInstantiationService);
    await selectSettings();
    return stock === undefined ? undefined : instantiation.invokeFunction(stock, ...args);
  };
  const place = () => {
    const current = CommandsRegistry.getCommand(id);
    if (current === undefined || current.handler === route) return;
    stock = current.handler;
    CommandsRegistry.registerCommand({ id, handler: route });
  };
  CommandsRegistry.onDidRegisterCommand((registered) => {
    if (registered === id) place();
  });
  place();
}
