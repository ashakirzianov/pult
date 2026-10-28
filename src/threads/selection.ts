import {
  getService,
  IContextKeyService,
  type IEditorGroup,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IStorageService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { CommandsRegistry, type ICommandHandler } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import { StorageScope, StorageTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { GroupsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { isSettingsTab, SettingsInput } from "../settings/pane.tsx";
import { DraftInput, isLeadTab, isShellTab, onDidPromoteDraft, ThreadInput } from "./pane.tsx";
import { isSubagent, type ShellProject, type ShelfName, threadStore } from "./store.ts";

/** The thread whose tabs the editor part shows, in the environment it belongs to. */
export interface ThreadSelection {
  readonly environmentId: string;
  readonly threadId: string;
}

/** A project's draft of a new thread, one per project, as upstream reuses a project's draft. */
export interface DraftSelection {
  readonly environmentId: string;
  readonly projectId: string;
}

/** Settings, content of its own beside the threads: the Pult settings page (`src/settings/`) with a tab set of its own. */
const SETTINGS = "settings";
type Selection = ThreadSelection | DraftSelection | typeof SETTINGS;

function isDraft(selection: Selection | undefined): selection is DraftSelection {
  return typeof selection === "object" && "projectId" in selection;
}

const STORAGE_KEY = "pult.shell.selectedThread";
const BEFORE_SETTINGS_KEY = "pult.shell.beforeSettings";

/** Whether the selected thread is a subagent's: the thread tab's title then offers its way back to the parent. */
const SubagentSelectedContext = new RawContextKey<boolean>("pult.subagentSelected", false);

const SHELF_LABELS: Record<ShelfName, string> = { pinned: "Pinned", active: "Active", snoozed: "Snoozed", settled: "Settled" };

/** The selected thread's parent, when the selected thread is a subagent's and the parent is known. */
function selectedParent(): ThreadSelection | undefined {
  const selection = selectedThread();
  const thread = selection && threadStore.thread(selection.environmentId, selection.threadId);
  if (thread === undefined || !isSubagent(thread) || thread.parentId === null) return undefined;
  const parent = threadStore.thread(thread.environmentId, thread.parentId);
  return parent && { environmentId: parent.environmentId, threadId: parent.id };
}

let selected: Selection | undefined;
/** The thread or draft Settings was selected from, which closing Settings' last tab goes back to. */
let beforeSettings: ThreadSelection | DraftSelection | undefined;
let switching = false;
let queue = Promise.resolve();
const listeners = new Set<() => void>();

/** The selected thread; undefined while Settings or a draft is selected. */
export function selectedThread(): ThreadSelection | undefined {
  return typeof selected === "object" && "threadId" in selected ? selected : undefined;
}

/** The selected draft of a new thread, if one is. */
export function selectedDraft(): DraftSelection | undefined {
  return isDraft(selected) ? selected : undefined;
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
export function selectThread(environmentId: string, threadId: string): Promise<void> {
  return enqueue(() => switchTo({ environmentId, threadId }));
}

/**
 * Selects Settings as a thread is selected: the selected thread's tabs are
 * saved, and the editor part shows Settings' own tab set, led by the Pult
 * settings page, opened leftmost in the first group, pinned, and active; the
 * VS Code editors it opens (the settings editor, keyboard shortcuts) join
 * that tab set beside it. Selecting a thread again restores that thread's
 * tabs, and so does closing Settings' last tab, for the thread or draft
 * Settings was selected from.
 */
export function selectSettings(): Promise<void> {
  return enqueue(() => switchTo(SETTINGS));
}

/**
 * Selects the project's draft of a new thread as a thread is selected: its
 * own tab set, led by the draft's tab (`DraftInput`), whose pane mounts
 * upstream's composer on the draft the view remembers for the project, or a
 * new one. The draft's tabs are kept as a working set like a thread's.
 */
export function selectDraft(environmentId: string, projectId: string): Promise<void> {
  return enqueue(() => switchTo({ environmentId, projectId }));
}

/**
 * The selected draft `promoted` became the thread `next` on the server, in
 * the environment its composer created it on: the thread is selected in its
 * place, with the draft's tabs as they are, its tab replaced by the thread's
 * in the same pane, which keeps the view mounted (`pane.tsx`); the draft's
 * selection and working set are gone. A draft no longer selected changes
 * nothing.
 */
function promoteDraft(promoted: DraftSelection, next: ThreadSelection): Promise<void> {
  return enqueue(async () => {
    const draft = selectedDraft();
    if (draft?.projectId !== promoted.projectId || draft.environmentId !== promoted.environmentId) return;
    const groups = await getService(IEditorGroupsService);
    const storage = await getService(IStorageService);
    const instantiation = await getService(IInstantiationService);
    switching = true;
    try {
      deleteWorkingSet(groups, draft);
      for (const group of groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
        const tab = group.editors.find((editor) => editor instanceof DraftInput);
        if (tab === undefined) continue;
        await group.replaceEditors([{ editor: tab, replacement: instantiation.createInstance(ThreadInput, next.environmentId, next.threadId) }]);
      }
      selected = next;
      storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    } finally {
      switching = false;
    }
    for (const listener of listeners) listener();
  });
}

function deleteWorkingSet(groups: IEditorGroupsService, selection: Selection): void {
  for (const set of groups.getWorkingSets()) {
    if (set.name === workingSetName(selection)) groups.deleteWorkingSet(set);
  }
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

  switching = true;
  try {
    // With nothing selected yet, the open editors become the new selection's tabs.
    if (selected !== undefined && workingSetName(selected) !== workingSetName(next)) {
      deleteWorkingSet(groups, selected);
      groups.saveWorkingSet(workingSetName(selected));
      const saved = groups.getWorkingSets().find((set) => set.name === workingSetName(next));
      await groups.applyWorkingSet(saved ?? "empty", { preserveFocus: true });
    }
    if (next === SETTINGS && selected !== undefined && selected !== SETTINGS) {
      beforeSettings = selected;
      storage.store(BEFORE_SETTINGS_KEY, JSON.stringify(selected), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    }
    selected = next;
    storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    if (next === SETTINGS) await showSettings();
    else await showLeadTab(next);
  } finally {
    switching = false;
  }
  for (const listener of listeners) listener();

  /** The thread's or draft's tab in the first group, leftmost; other threads' and drafts' tabs leave. */
  async function showLeadTab(lead: ThreadSelection | DraftSelection): Promise<void> {
    const isOwn = (editor: ThreadInput | DraftInput) =>
      editor.environmentId === lead.environmentId &&
      (isDraft(lead)
        ? editor instanceof DraftInput && editor.projectId === lead.projectId
        : editor instanceof ThreadInput && editor.threadId === lead.threadId);
    await closeLeadTabs((editor) => !isOwn(editor));
    const first = groups.getGroups(GroupsOrder.GRID_APPEARANCE)[0] ?? groups.activeGroup;
    if (!first.editors.some(isLeadTab)) {
      const tab = isDraft(lead)
        ? instantiation.createInstance(DraftInput, lead.environmentId, lead.projectId)
        : instantiation.createInstance(ThreadInput, lead.environmentId, lead.threadId);
      await first.openEditor(tab, { pinned: true, index: 0 });
    }
    keepThreadTabsFirst(groups.getGroups(GroupsOrder.GRID_APPEARANCE));
  }

  /**
   * No thread tab, and the settings page active and leftmost: where
   * Settings' working set holds it already, else new in the first group.
   */
  async function showSettings(): Promise<void> {
    await closeLeadTabs(() => true);
    const ordered = groups.getGroups(GroupsOrder.GRID_APPEARANCE);
    const holding = ordered.find((group) => group.editors.some(isSettingsTab));
    const group = holding ?? ordered[0] ?? groups.activeGroup;
    const page = group.editors.find(isSettingsTab) ?? instantiation.createInstance(SettingsInput);
    await group.openEditor(page, { pinned: true, index: 0 });
    keepThreadTabsFirst(ordered);
  }

  async function closeLeadTabs(stale: (editor: ThreadInput | DraftInput) => boolean): Promise<void> {
    for (const group of groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      const closing = group.editors.filter((editor) => isLeadTab(editor) && stale(editor));
      if (closing.length > 0) await group.closeEditors(closing, { force: true });
    }
  }
}

function workingSetName(selection: Selection): string {
  if (selection === SETTINGS) return "pult.settings";
  return isDraft(selection)
    ? `pult.draft/${selection.environmentId}/${selection.projectId}`
    : `pult.thread/${selection.environmentId}/${selection.threadId}`;
}

/**
 * Moves a thread's or draft's tab, or the settings page, back to the left
 * edge of its group. Not sticky: a sticky tab offers an unpin button, and a
 * dragged editor can still land before it, so the shell puts it back after
 * every change instead.
 */
function keepThreadTabsFirst(groups: ReadonlyArray<IEditorGroup>): void {
  for (const group of groups) {
    const tab = group.editors.find(isShellTab);
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
  const savedBefore = storage.get(BEFORE_SETTINGS_KEY, StorageScope.WORKSPACE);
  if (savedBefore !== undefined) beforeSettings = JSON.parse(savedBefore) as ThreadSelection | DraftSelection;
  const groups = await getService(IEditorGroupsService);
  const editors = await getService(IEditorService);
  editors.onDidEditorsChange(() => {
    if (!switching) queueMicrotask(() => keepThreadTabsFirst(groups.groups));
  });
  // Closing Settings' last tab goes back to the thread or draft it was opened from, while the page holds its environment.
  editors.onDidCloseEditor(() => {
    const back = beforeSettings;
    if (switching || selected !== SETTINGS || editors.count > 0) return;
    if (back === undefined || threadStore.environment(back.environmentId) === undefined) return;
    void enqueue(() => (selected === SETTINGS && editors.count === 0 ? switchTo(back) : Promise.resolve()));
  });
  for (const listener of listeners) listener();
  // Whether the selection is a subagent's: on each switch, and as the store learns of the thread and its parent.
  const subagentKey = SubagentSelectedContext.bindTo(await getService(IContextKeyService));
  const updateSubagentKey = () => subagentKey.set(selectedParent() !== undefined);
  onDidSelectThread(updateSubagentKey);
  threadStore.subscribe(updateSubagentKey);
  updateSubagentKey();
}

/**
 * `pult-shell.selectThread [environmentId] [threadId]`, the palette's "Pult:
 * Open Thread…": a thread id alone is the first thread the store lists with
 * it; with no id, a quick pick of every environment's threads in the cards'
 * order, subagents left out, each one's environment named while the page
 * holds several. `pult-shell.selectSettings`, the palette's "Pult: Show
 * Settings", on Cmd+, over the workbench's own binding, which would open
 * the settings editor under the thread; and the workbench's own Settings
 * and Keyboard Shortcuts commands routed through Settings (`SETTINGS_ROUTES`).
 * `pult-shell.newThread`, a project's draft; a draft's promotion selects
 * its thread.
 */
export function registerSelectThreadCommand(): void {
  for (const route of SETTINGS_ROUTES) routeToSettings(route);
  onDidPromoteDraft((draft, thread) => void promoteDraft(draft, thread));
  registerNewThreadCommand();
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectThread",
          title: { value: "Open Thread…", original: "Open Thread…" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      async run(accessor: ServicesAccessor, first?: unknown, second?: unknown): Promise<void> {
        if (typeof first === "string" && typeof second === "string") return selectThread(first, second);
        if (typeof first === "string") {
          const environmentId = threadStore.environmentOfThread(first);
          if (environmentId === undefined) throw new Error(`Pult knows no thread ${first}.`);
          return selectThread(environmentId, first);
        }
        // Services are read before any await; the accessor is only valid synchronously.
        const quickInput = accessor.get(IQuickInputService);
        const { threads } = threadStore.get();
        const current = selectedThread();
        // The store lists the shelves in the cards' order, pinned and active first; a subagent has none.
        const items = threads.flatMap((thread) =>
          thread.shelf === null
            ? []
            : [
                {
                  thread,
                  label: thread.title,
                  description: [thread.projectName, threadStore.distinguishing(thread.environmentId), SHELF_LABELS[thread.shelf]]
                    .filter((part) => part !== undefined)
                    .join(" · "),
                },
              ],
        );
        const picked = await quickInput.pick(items, {
          placeHolder: "Open a thread",
          matchOnDescription: true,
          activeItem: items.find(({ thread }) => thread.id === current?.threadId && thread.environmentId === current.environmentId),
        });
        if (picked !== undefined) await selectThread(picked.thread.environmentId, picked.thread.id);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectParentThread",
          title: { value: "Back to Parent Thread", original: "Back to Parent Thread" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.arrowUp,
          f1: true,
          precondition: SubagentSelectedContext,
          // In the thread tab's title, left of Split Editor, while a subagent's thread tab is the active one.
          menu: {
            id: MenuId.EditorTitle,
            when: ContextKeyExpr.and(SubagentSelectedContext, ContextKeyExpr.equals("activeEditor", "pult.shell.threadPane")),
            group: "navigation",
            order: -100,
          },
        });
      }

      async run(): Promise<void> {
        const parent = selectedParent();
        if (parent !== undefined) await selectThread(parent.environmentId, parent.threadId);
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
 * `pult-shell.newThread [environmentId] [projectId]`, the palette's "Pult:
 * New Thread" on Cmd+N: with a project, selects its draft (a project id
 * alone is the first project the store lists with it); without, picks one of
 * every environment's projects first in the shell's quick input, the
 * selected thread's or draft's project first, then by name, each one's
 * environment named while the page holds several; one project needs no pick. The Threads tab's title
 * (`src/panel/view.tsx`) runs it too. Cmd+N is bound over the workbench's New
 * Untitled File, as upstream binds `chat.new`, so the palette shows the key.
 */
function registerNewThreadCommand(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.newThread",
          title: { value: "New Thread", original: "New Thread" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyN, weight: KeybindingWeight.WorkbenchContrib + 1 },
        });
      }

      async run(accessor: ServicesAccessor, first?: unknown, second?: unknown): Promise<void> {
        if (typeof first === "string" && typeof second === "string") return selectDraft(first, second);
        // Services are read before any await; the accessor is only valid synchronously.
        const quickInput = accessor.get(IQuickInputService);
        const notifications = accessor.get(INotificationService);
        const { environments, projects } = threadStore.get();
        if (typeof first === "string") {
          const project = projects.find((candidate) => candidate.id === first);
          if (project === undefined) throw new Error(`Pult knows no project ${first}.`);
          return selectDraft(project.environmentId, project.id);
        }
        if (environments.length === 0) return notifications.info("Pult is not connected to an environment.");
        const selection = selectedThread();
        const thread = selection && threadStore.thread(selection.environmentId, selection.threadId);
        const current = selectedDraft() ?? (thread && { environmentId: thread.environmentId, projectId: thread.projectId });
        const isCurrent = (project: ShellProject) =>
          Number(project.id === current?.projectId && project.environmentId === current.environmentId);
        const sorted = projects.toSorted((left, right) => isCurrent(right) - isCurrent(left) || left.name.localeCompare(right.name));
        if (sorted.length === 0) return notifications.info("No connected environment has projects.");
        const chosen =
          sorted.length === 1
            ? sorted[0]
            : (
                await quickInput.pick(
                  sorted.map((project) => ({
                    project,
                    label: project.name,
                    description: [threadStore.distinguishing(project.environmentId), project.root ?? undefined]
                      .filter((part) => part !== undefined)
                      .join(" · "),
                  })),
                  { placeHolder: "New thread in project", matchOnDescription: true },
                )
              )?.project;
        if (chosen !== undefined) await selectDraft(chosen.environmentId, chosen.id);
      }
    },
  );
}

/**
 * The workbench's own commands that open an editor of Settings', routed
 * through the Settings selection: left alone each would open its editor
 * among the selected thread's tabs. `workbench.action.openSettings`, the
 * stock Settings (the activity bar's Manage menu, the palette's
 * "Preferences: Open Settings", the links that open a setting by query),
 * is the Pult settings page when called without arguments, and with a
 * query, a link or the JSON editor's options opens VS Code's settings editor
 * beside the page. `workbench.action.openGlobalKeybindings`, Keyboard
 * Shortcuts, always opens its editor beside the page.
 */
const SETTINGS_ROUTES = [
  { id: "workbench.action.openSettings", pageWithoutArguments: true },
  { id: "workbench.action.openGlobalKeybindings", pageWithoutArguments: false },
];

/**
 * Selects Settings, then runs the stock handler with the arguments, unless
 * the call without arguments is the page alone. The stock command registers
 * when its contribution starts, after the shell's registrations, and the
 * registry's latest registration wins, so the route goes on top of it then,
 * and again if it is ever registered anew.
 */
function routeToSettings({ id, pageWithoutArguments }: (typeof SETTINGS_ROUTES)[number]): void {
  let stock: ICommandHandler | undefined;
  const route: ICommandHandler = async (accessor, ...args) => {
    // Services are read before any await; the accessor is only valid synchronously.
    const instantiation = accessor.get(IInstantiationService);
    await selectSettings();
    // A menu runs its command with no argument, or with an undefined context.
    if (stock === undefined || (pageWithoutArguments && args.every((arg) => arg === undefined))) return undefined;
    return instantiation.invokeFunction(stock, ...args);
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
