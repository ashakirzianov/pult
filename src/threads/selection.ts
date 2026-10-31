import {
  getService,
  ICommandService,
  IContextKeyService,
  type IEditorGroup,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IStorageService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { ConfirmResult } from "@codingame/monaco-vscode-api/vscode/vs/platform/dialogs/common/dialogs";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import { StorageScope, StorageTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import type { IEditorCloseHandler } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput";
import { GroupsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { SettingsInput } from "../settings/pane.tsx";
import { DraftInput, isLeadTab, onDidPromoteDraft, ThreadInput } from "./pane.tsx";
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

/** The Explorer workspace: files opened under no thread, their tabs a set of their own. */
interface ExplorerSelection {
  readonly explorer: true;
}

const EXPLORER: ExplorerSelection = { explorer: true };

type Selection = ThreadSelection | DraftSelection | ExplorerSelection;

function isDraft(selection: Selection | undefined): selection is DraftSelection {
  return typeof selection === "object" && "projectId" in selection;
}

function isExplorer(selection: Selection | undefined): selection is ExplorerSelection {
  return typeof selection === "object" && "explorer" in selection;
}

const STORAGE_KEY = "pult.shell.selectedThread";
/** The Explorer workspace's open files, as last seen while it was selected: the Explorer shelf lists them. */
const EXPLORER_FILES_KEY = "pult.shell.explorerFiles";
/** What the shell stored while Settings was a selection of its own (until 2026-10-28), cleared at startup. */
const RETIRED_BEFORE_SETTINGS_KEY = "pult.shell.beforeSettings";
const RETIRED_SETTINGS_WORKING_SET = "pult.settings";

/** Whether the selected thread is a subagent's: the thread tab's title then offers its way back to the parent. */
const SubagentSelectedContext = new RawContextKey<boolean>("pult.subagentSelected", false);

const SHELF_LABELS: Record<ShelfName, string> = {
  pinned: "Pinned",
  active: "Active",
  working: "Working",
  snoozed: "Snoozed",
  settled: "Settled",
};

/** The selected thread's parent, when the selected thread is a subagent's and the parent is known. */
function selectedParent(): ThreadSelection | undefined {
  const selection = selectedThread();
  const thread = selection && threadStore.thread(selection.environmentId, selection.threadId);
  if (thread === undefined || !isSubagent(thread) || thread.parentId === null) return undefined;
  const parent = threadStore.thread(thread.environmentId, thread.parentId);
  return parent && { environmentId: parent.environmentId, threadId: parent.id };
}

let selected: Selection | undefined;
let switching = false;
let queue = Promise.resolve();
const listeners = new Set<() => void>();

/** The selected thread; undefined while a draft is selected. */
export function selectedThread(): ThreadSelection | undefined {
  return selected !== undefined && "threadId" in selected ? selected : undefined;
}

/** The selected draft of a new thread, if one is. */
export function selectedDraft(): DraftSelection | undefined {
  return isDraft(selected) ? selected : undefined;
}

/** Whether the Explorer workspace is selected. */
export function explorerSelected(): boolean {
  return isExplorer(selected);
}

/** The Explorer workspace's open files, in their groups' order, and its active editor's file, if it has one. */
export interface ExplorerFiles {
  readonly files: ReadonlyArray<URI>;
  readonly active: URI | undefined;
}

let explorerFiles: ExplorerFiles = { files: [], active: undefined };
const explorerFilesListeners = new Set<() => void>();

/** The Explorer workspace's open files, live while it is selected, as last seen otherwise: the same object until they change. */
export const openExplorerFiles = {
  get: () => explorerFiles,
  subscribe(listener: () => void): () => void {
    explorerFilesListeners.add(listener);
    return () => explorerFilesListeners.delete(listener);
  },
};

/** Records the open files while the Explorer workspace is selected and no switch is swapping the editor part. */
function recordExplorerFiles(editors: IEditorService, storage: IStorageService): void {
  if (!isExplorer(selected) || switching) return;
  const seen = new Set<string>();
  const files = editors.editors.flatMap((editor) => {
    const resource = editor.resource;
    if (resource === undefined || seen.has(resource.toString())) return [];
    seen.add(resource.toString());
    return [resource];
  });
  const active = editors.activeEditor?.resource;
  const sameFiles = files.length === explorerFiles.files.length && files.every((file, index) => file.toString() === explorerFiles.files[index]?.toString());
  if (sameFiles && active?.toString() === explorerFiles.active?.toString()) return;
  explorerFiles = { files, active };
  if (!sameFiles) storage.store(EXPLORER_FILES_KEY, JSON.stringify(files.map(String)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
  for (const listener of explorerFilesListeners) listener();
}

/**
 * Selects the Explorer workspace, the files of the environments opened under
 * no thread: its tab set as a thread's is, with no lead tab. With
 * `showExplorerTab`, the sidebar shows the Explorer tab too, which shows
 * every environment's home while this workspace is selected
 * (`src/panel/explorer.ts`).
 */
export function selectExplorer(showExplorerTab = false): Promise<void> {
  return enqueue(async () => {
    await switchTo(EXPLORER);
    if (showExplorerTab) await (await getService(ICommandService)).executeCommand("workbench.view.explorer");
  });
}

/** Selects the Explorer workspace and shows the open file `resource` there, in the group that holds it. */
export function showExplorerFile(resource: URI): Promise<void> {
  return enqueue(async () => {
    await switchTo(EXPLORER);
    await (await getService(IEditorService)).openEditor({ resource, options: { revealIfOpened: true, pinned: true } });
  });
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
export function selectThread(environmentId: string, threadId: string): Promise<void> {
  return enqueue(() => switchTo({ environmentId, threadId }));
}

/**
 * Opens the Pult settings page (`src/settings/`) as a tab of the selected
 * thread's or draft's tab set, in the active group, pinned, and active; a
 * page open in any group is shown instead. Settings is no selection of its
 * own: the tab goes with the thread's working set and closes like any tab
 * (`pult/decisions`, `settings-selection`). Queued behind any switch in
 * flight, which swaps the editor part.
 */
export function showSettings(): Promise<void> {
  return enqueue(async () => {
    const groups = await getService(IEditorGroupsService);
    const instantiation = await getService(IInstantiationService);
    const holding = groups.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE).find((group) => group.editors.some(isSettingsTab));
    const group = holding ?? groups.activeGroup;
    const page = group.editors.find(isSettingsTab) ?? instantiation.createInstance(SettingsInput);
    await group.openEditor(page, { pinned: true });
  });
}

function isSettingsTab(editor: unknown): editor is SettingsInput {
  return editor instanceof SettingsInput;
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
      const restoreCloseHandlers = await closeModifiedFilesSilently();
      const saved = groups.getWorkingSets().find((set) => set.name === workingSetName(next));
      await groups.applyWorkingSet(saved ?? "empty", { preserveFocus: true }).finally(restoreCloseHandlers);
    }
    selected = next;
    storage.store(STORAGE_KEY, JSON.stringify(next), StorageScope.WORKSPACE, StorageTarget.MACHINE);
    await showLeadTab(next);
  } finally {
    switching = false;
  }
  for (const listener of listeners) listener();
  // The selection is stored at once, the editor part's state only when the workbench saves its state (at intervals, and at
  // shutdown, which a page's reload may not finish): saved now, a reload restores the tabs of the selection it restores.
  void storage.flush();

  /**
   * Lets the tabs of modified files close without asking, as the working
   * set's apply closes every tab: it keeps those that would ask, and they
   * would follow the switch into the next selection. A file's model stays
   * modified with its tab closed (the text file service keeps a modified
   * model alive), and the saved working set reopens a tab on it. Given an
   * editor input's close handler, which the workbench asks before its own
   * dirty check, for the switch; returns what takes it back off a tab that
   * stayed open.
   */
  async function closeModifiedFilesSilently(): Promise<() => void> {
    const files = await getService(IFileService);
    const modified = groups
      .getGroups(GroupsOrder.GRID_APPEARANCE)
      .flatMap((group) => group.editors)
      .filter((editor) => editor.isDirty() && editor.closeHandler === undefined && editor.resource !== undefined && files.hasProvider(editor.resource));
    const handler: IEditorCloseHandler = { showConfirm: () => false, confirm: async () => ConfirmResult.CANCEL };
    for (const editor of modified) Object.assign(editor, { closeHandler: handler });
    return () => {
      for (const editor of modified) if (editor.closeHandler === handler) Object.assign(editor, { closeHandler: undefined });
    };
  }

  /** The thread's or draft's tab in the first group, leftmost; other threads' and drafts' tabs leave, all of them for the Explorer workspace. */
  async function showLeadTab(lead: Selection): Promise<void> {
    if (isExplorer(lead)) return closeLeadTabs(() => true);
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

  async function closeLeadTabs(stale: (editor: ThreadInput | DraftInput) => boolean): Promise<void> {
    for (const group of groups.getGroups(GroupsOrder.GRID_APPEARANCE)) {
      const closing = group.editors.filter((editor) => isLeadTab(editor) && stale(editor));
      if (closing.length > 0) await group.closeEditors(closing, { force: true });
    }
  }
}

function workingSetName(selection: Selection): string {
  if (isExplorer(selection)) return "pult.explorer";
  return isDraft(selection)
    ? `pult.draft/${selection.environmentId}/${selection.projectId}`
    : `pult.thread/${selection.environmentId}/${selection.threadId}`;
}

/**
 * Moves a thread's or draft's tab back to the left edge of its group. Not
 * sticky: a sticky tab offers an unpin button, and a dragged editor can still
 * land before it, so the shell puts it back after every change instead.
 */
function keepThreadTabsFirst(groups: ReadonlyArray<IEditorGroup>): void {
  for (const group of groups) {
    const tab = group.editors.find(isLeadTab);
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
  const parsed: unknown = saved === undefined ? undefined : JSON.parse(saved);
  // A page that last had Settings selected, when that was a selection, starts with none.
  if (typeof parsed === "object" && parsed !== null) selected = parsed as Selection;
  storage.remove(RETIRED_BEFORE_SETTINGS_KEY, StorageScope.WORKSPACE);
  const groups = await getService(IEditorGroupsService);
  for (const set of groups.getWorkingSets()) if (set.name === RETIRED_SETTINGS_WORKING_SET) groups.deleteWorkingSet(set);
  const editors = await getService(IEditorService);
  const files: unknown = JSON.parse(storage.get(EXPLORER_FILES_KEY, StorageScope.WORKSPACE) ?? "[]");
  if (Array.isArray(files)) explorerFiles = { files: files.filter((file) => typeof file === "string").map((file) => URI.parse(file)), active: undefined };
  editors.onDidEditorsChange(() => {
    if (!switching) queueMicrotask(() => keepThreadTabsFirst(groups.groups));
    recordExplorerFiles(editors, storage);
  });
  editors.onDidActiveEditorChange(() => recordExplorerFiles(editors, storage));
  onDidSelectThread(() => recordExplorerFiles(editors, storage));
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
 * Settings", on Cmd+, over the workbench's own binding, opens the Pult
 * settings page among the thread's tabs; the left panel's gear runs it
 * too (`src/panel/rows.tsx`). `pult-shell.newThread`, a project's draft;
 * a draft's promotion selects its thread.
 */
export function registerSelectThreadCommand(): void {
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
          id: "pult-shell.selectExplorer",
          title: { value: "Open Explorer Workspace", original: "Open Explorer Workspace" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(_accessor: ServicesAccessor, resource?: unknown): Promise<void> {
        return typeof resource === "string" ? showExplorerFile(URI.parse(resource)) : selectExplorer();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.exploreFiles",
          title: { value: "Explore Files", original: "Explore Files" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(): Promise<void> {
        return selectExplorer(true);
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
        return showSettings();
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
 * environment named while the page holds several; one project needs no pick. The Pult tab's title
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
