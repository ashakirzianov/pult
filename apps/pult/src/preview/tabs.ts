// The preview tabs of the shell (`pult/decisions`, `preview-tabs`): where the
// view's `openPreview` and `closeStalePreviews` go (`src/threads/pane.tsx`),
// the palette's Open Browser and Close Browser Session and the tab bar's
// button, closing a tab by its session's owner, and the tabs' place in the
// selection's tab set (`thread-tab-sets`).
import {
  getService,
  type IEditorGroup,
  IEditorGroupsService,
  INotificationService,
  IQuickInputService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { EditorCloseContext } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import { GroupsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import type { ThreadPreviewSessions } from "../../view/main.tsx";

import { starStore } from "../stars/model.ts";
import { isLeadTab, setPreviewTabs, threadView } from "../threads/pane.tsx";
import { ThreadSelectedContext } from "../threads/park.ts";
import {
  isSwitchingThread,
  onDidSelectThread,
  selectedStar,
  selectionTarget,
  selectThread,
  type ThreadSelection,
} from "../threads/selection.ts";
import { isPreviewTab, PreviewInput, registerPreviewPane } from "./pane.tsx";
import {
  closingEndsSession,
  liveReveals,
  type PreviewOwner,
  placementGroup,
  staleTabs,
} from "./rules.ts";
import { currentSessions, followSessions, loadedSessions, threadKey } from "./sessions.ts";

const OWNER_LABELS: Record<PreviewOwner, string> = {
  agent: "Agent's",
  human: "Yours",
  unclaimed: "Unclaimed",
};

const tabKey = (environmentId: string, threadId: string, tabId: string) =>
  `${threadKey(environmentId, threadId)}\u0000${tabId}`;

/** When the page opened a session's tab, for the stale tabs' just-opened guard (`staleTabs`). */
const openedAt = new Map<string, number>();
/** Tabs the shell closes itself, which their close does not end the session of. */
const closingByShell = new WeakSet<PreviewInput>();
/** Sessions revealed while their thread was not the selection's, opened in the background when it is next. */
const pending = new Map<string, Set<string>>();
/** Sessions whose close the page asked for and has not heard back of, whose tabs the stale lists leave alone. */
const closing = new Set<string>();
/** Per thread, the look again at tabs a just-opened guard kept. */
const rechecks = new Map<string, ReturnType<typeof setTimeout>>();

let queue = Promise.resolve();

/** The tab operations run one at a time, in call order, so an open and a stale list never interleave. */
function enqueue(run: () => Promise<void>): Promise<void> {
  const next = queue.then(run);
  queue = next.catch((error: unknown) => console.error("[pult-shell] preview tabs", error));
  return next;
}

/** The thread whose preview tabs the editor part shows: the selected thread, or the selected Star's conversation. */
function targetThread(): ThreadSelection | undefined {
  const target = selectionTarget();
  return target !== undefined && "threadId" in target ? target : undefined;
}

/** Remembers a reveal of a session of a thread not the selection's, for when it is next (`openRemembered`). */
function remember(environmentId: string, threadId: string, tabId: string | null): void {
  if (tabId === null) return;
  const key = threadKey(environmentId, threadId);
  pending.set(key, new Set(pending.get(key)).add(tabId));
}

function isTarget(environmentId: string, threadId: string): boolean {
  const target = targetThread();
  return (
    !isSwitchingThread() && target?.environmentId === environmentId && target.threadId === threadId
  );
}

function previewTabs(
  groups: IEditorGroupsService,
  thread?: ThreadSelection,
): Array<{ readonly group: IEditorGroup; readonly editor: PreviewInput }> {
  return groups
    .getGroups(GroupsOrder.GRID_APPEARANCE)
    .flatMap((group) =>
      group.editors
        .filter((editor) => isPreviewTab(editor, thread))
        .map((editor) => ({ group, editor: editor as PreviewInput })),
    );
}

async function closeTabs(
  tabs: ReadonlyArray<{ readonly group: IEditorGroup; readonly editor: PreviewInput }>,
): Promise<void> {
  for (const { group, editor } of tabs) {
    closingByShell.add(editor);
    await group.closeEditors([editor], { preserveFocus: true });
  }
}

/**
 * The host's `openPreview` (`view/host.ts`): the session's tab, opened if the
 * thread has none for it, in the background unless `activate`; an open one
 * activated when `activate`. A null `tabId` is a New browser's placeholder,
 * the thread's open one shown rather than a second opened; with
 * `replacePlaceholder` the thread's open placeholder becomes the session's
 * tab in place. A new tab goes to the group of the thread's latest preview
 * tab, else the thread tab's (`placementGroup`), pinned. Only for the
 * selection's thread (the selected one, or the selected Star's conversation),
 * looked at again after each wait: a session another thread's agent reveals,
 * or one revealed while a switch runs, is remembered and opens in the
 * background when that thread is next selected, if still live, so a tab never
 * shows under another selection. `focus` moves the keyboard to the tab, for
 * the user's own ways in; the view's opens leave it where it is.
 */
function openPreview(
  environmentId: string,
  threadId: string,
  tabId: string | null,
  options: {
    readonly activate: boolean;
    readonly replacePlaceholder?: boolean;
    readonly focus?: boolean;
  },
): Promise<void> {
  return enqueue(async () => {
    if (!isTarget(environmentId, threadId)) return remember(environmentId, threadId, tabId);
    const groups = await getService(IEditorGroupsService);
    if (!isTarget(environmentId, threadId)) return remember(environmentId, threadId, tabId);
    const thread = { environmentId, threadId };
    const tabs = previewTabs(groups, thread);
    const shown = { pinned: true, preserveFocus: options.focus !== true };
    const existing = tabs.find(({ editor }) => editor.tabId === tabId);
    if (existing !== undefined) {
      if (options.activate) await existing.group.openEditor(existing.editor, shown);
      return;
    }
    if (tabId !== null) openedAt.set(tabKey(environmentId, threadId, tabId), Date.now());
    const input = new PreviewInput(environmentId, threadId, tabId);
    const placeholder =
      tabId !== null && options.replacePlaceholder === true
        ? tabs.find(({ editor }) => editor.tabId === null)
        : undefined;
    if (placeholder !== undefined) {
      placeholder.editor.promotedTo = tabId ?? undefined;
      await placeholder.group.replaceEditors([
        { editor: placeholder.editor, replacement: input, options: shown },
      ]);
      return;
    }
    const lead = groups
      .getGroups(GroupsOrder.GRID_APPEARANCE)
      .find((group) => group.editors.some(isLeadTab));
    const group = placementGroup(
      tabs.map(({ group, editor }) => ({ group, seen: editor.seen })),
      lead,
      groups.activeGroup,
    );
    // After the thread's last browser in the group, so they keep the order they opened in.
    const last = Math.max(
      -1,
      ...tabs
        .filter((tab) => tab.group === group)
        .map(({ editor }) => group.getIndexOfEditor(editor)),
    );
    const index = last < 0 ? {} : { index: last + 1 };
    await group.openEditor(
      input,
      options.activate
        ? { ...shown, ...index }
        : { pinned: true, inactive: true, preserveFocus: true, ...index },
    );
  });
}

/**
 * The host's `closeStalePreviews`, and the shell's own on each loaded list of
 * a thread it follows: the thread's tabs whose session ended close, without
 * asking, but a tab the page just opened, which waits a moment for the list
 * to catch up, looked at again then, and one whose session's close is in
 * flight; nothing while the view's list of the thread has not loaded, as
 * upstream's reconcile may call before an environment's config is in
 * (`staleTabs`). Placeholders stay. The thread's remembered reveals keep only
 * the live sessions.
 */
function closeStalePreviews(
  environmentId: string,
  threadId: string,
  liveTabIds: ReadonlyArray<string>,
): Promise<void> {
  return enqueue(async () => {
    const { loaded } = (await threadView()).previewSessions(environmentId, threadId);
    const key = threadKey(environmentId, threadId);
    const remembered = pending.get(key);
    if (loaded && remembered !== undefined) {
      const live = liveReveals(remembered, liveTabIds);
      if (live.size === 0) pending.delete(key);
      else pending.set(key, new Set(live));
    }
    if (isSwitchingThread()) return;
    const groups = await getService(IEditorGroupsService);
    const now = Date.now();
    for (const [key, at] of openedAt) if (now - at > 60_000) openedAt.delete(key);
    const tabs = previewTabs(groups, { environmentId, threadId });
    const { close, recheckAt } = staleTabs({
      open: tabs.flatMap(({ editor }) => (editor.tabId === null ? [] : [editor.tabId])),
      live: liveTabIds,
      openedAt: (tabId) => openedAt.get(tabKey(environmentId, threadId, tabId)),
      closing: (tabId) => closing.has(tabKey(environmentId, threadId, tabId)),
      loaded,
      now,
    });
    await closeTabs(
      tabs.filter(({ editor }) => editor.tabId !== null && close.includes(editor.tabId)),
    );
    clearTimeout(rechecks.get(key));
    rechecks.delete(key);
    if (recheckAt === undefined) return;
    rechecks.set(
      key,
      setTimeout(() => {
        rechecks.delete(key);
        void currentSessions(environmentId, threadId).then(({ loaded, sessions }) => {
          if (loaded)
            void closeStalePreviews(
              environmentId,
              threadId,
              sessions.map((session) => session.tabId),
            );
        });
      }, recheckAt - now),
    );
  });
}

/**
 * Ends a session (Close Browser Session, the pane's more menu), its tab
 * closing with it once the server ends it; until then the stale lists, which
 * already lack the session (upstream drops it from the view at once), leave
 * the tab alone, so a refusal, told, leaves the session with its tab.
 */
async function endSession(environmentId: string, threadId: string, tabId: string): Promise<void> {
  const key = tabKey(environmentId, threadId, tabId);
  closing.add(key);
  try {
    const ended = await (await threadView()).closePreviewSession(environmentId, threadId, tabId);
    if (!ended) {
      (await getService(INotificationService)).warn("The browser session did not close.");
      return;
    }
    await enqueue(async () => {
      const groups = await getService(IEditorGroupsService);
      await closeTabs(
        previewTabs(groups, { environmentId, threadId }).filter(
          ({ editor }) => editor.tabId === tabId,
        ),
      );
    });
  } finally {
    closing.delete(key);
  }
}

/** A tab the user closed: its session ends when the user's or no one's, an agent's lives on (`closingEndsSession`). */
async function closedByUser(editor: PreviewInput): Promise<void> {
  const tabId = editor.tabId;
  if (tabId === null) return;
  const { sessions } = await currentSessions(editor.environmentId, editor.threadId);
  const owner = sessions.find((session) => session.tabId === tabId)?.owner;
  if (!closingEndsSession(owner)) return;
  const view = await threadView();
  if (!(await view.closePreviewSession(editor.environmentId, editor.threadId, tabId)))
    (await getService(INotificationService)).warn("The browser session did not close.");
}

/** The threads the shell follows the sessions of: those with preview tabs, and the selection's. */
const follows = new Map<string, () => void>();

function onSessions(environmentId: string, threadId: string, list: ThreadPreviewSessions): void {
  if (!list.loaded) return;
  const live = list.sessions.map((session) => session.tabId);
  void closeStalePreviews(environmentId, threadId, live);
  openRemembered(environmentId, threadId, live);
}

/** The thread's remembered reveals of the sessions in `live`, opened in the background while it is the selection's. */
function openRemembered(
  environmentId: string,
  threadId: string,
  live: ReadonlyArray<string>,
): void {
  const key = threadKey(environmentId, threadId);
  const waiting = pending.get(key);
  if (waiting === undefined || !isTarget(environmentId, threadId)) return;
  pending.delete(key);
  for (const tabId of liveReveals(waiting, live))
    void openPreview(environmentId, threadId, tabId, { activate: false });
}

async function refreshFollows(): Promise<void> {
  if (isSwitchingThread()) return;
  const groups = await getService(IEditorGroupsService);
  const wanted = new Map<string, ThreadSelection>();
  for (const { editor } of previewTabs(groups)) {
    wanted.set(threadKey(editor.environmentId, editor.threadId), editor);
  }
  const target = targetThread();
  if (target !== undefined) wanted.set(threadKey(target.environmentId, target.threadId), target);
  for (const [key, stop] of follows) {
    if (wanted.has(key)) continue;
    follows.delete(key);
    stop();
  }
  for (const [key, { environmentId, threadId }] of wanted) {
    if (follows.has(key)) continue;
    follows.set(
      key,
      followSessions(environmentId, threadId, (list) => onSessions(environmentId, threadId, list)),
    );
  }
}

/**
 * A preview tab belongs to its thread's tab set: the working sets keep a
 * thread's own, and a Star's set holds its current conversation's alone, so
 * a conversation's end, or anything else that leaves another thread's tab
 * in the part, closes it, a dismissal that ends no session. Nothing while a
 * Star's conversation is not known yet (its Stars still loading).
 */
async function closeForeignTabs(): Promise<void> {
  if (isSwitchingThread()) return;
  const target = targetThread();
  if (target === undefined && selectedStar() !== undefined) return;
  const groups = await getService(IEditorGroupsService);
  await closeTabs(
    previewTabs(groups).filter(
      ({ editor }) =>
        editor.environmentId !== target?.environmentId || editor.threadId !== target.threadId,
    ),
  );
}

/**
 * Registers the preview tab's pane and its commands, and hands the view's
 * host its preview outlets. Before the workbench starts.
 *
 * `pult-shell.openPreview [environmentId threadId [tabId]]`, the palette's
 * Pult: Open Browser and the tab bar's globe beside Split Editor, while a
 * thread is selected or the selected Star has a conversation: a session's
 * tab, active; with no tab id a pick of the thread's live sessions (label,
 * URL, owner) and New, straight to New with none; a thread named that is not
 * the selection's is selected first. `pult-shell.closePreviewSession
 * [environmentId threadId [tabId]]`, the palette's Pult: Close Browser
 * Session and the pane's more menu: ends a session, picked from the
 * selection's thread's without a tab id.
 */
export function registerPreviewTabs(): void {
  registerPreviewPane();
  setPreviewTabs({
    openPreview: (environmentId, threadId, tabId, options) =>
      void openPreview(environmentId, threadId, tabId, options),
    closeStalePreviews: (environmentId, threadId, liveTabIds) =>
      void closeStalePreviews(environmentId, threadId, liveTabIds),
  });
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openPreview",
          title: { value: "Open Browser", original: "Open Browser" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.globe,
          f1: true,
          precondition: ThreadSelectedContext,
          // Beside Split Editor (its order is 100000) in every group's tab bar.
          menu: {
            id: MenuId.EditorTitle,
            when: ThreadSelectedContext,
            group: "navigation",
            order: 99_999,
          },
        });
      }

      async run(
        accessor: ServicesAccessor,
        environmentId?: unknown,
        threadId?: unknown,
        tabId?: unknown,
      ): Promise<void> {
        // Services are read before any await; the accessor is only valid synchronously.
        const quickInput = accessor.get(IQuickInputService);
        const thread = await namedThread(environmentId, threadId);
        if (thread === undefined) return;
        const open = (session: string | null) =>
          openPreview(thread.environmentId, thread.threadId, session, {
            activate: true,
            focus: true,
          });
        if (typeof tabId === "string") return open(tabId);
        const { sessions } = await loadedSessions(thread.environmentId, thread.threadId);
        if (sessions.length === 0) return open(null);
        const picked = await quickInput.pick(
          [
            ...sessions.map((session) => ({
              label: session.label,
              description: [session.url, OWNER_LABELS[session.owner]]
                .filter((part) => part !== null)
                .join(" · "),
              tabId: session.tabId as string | null,
            })),
            { label: "New Browser", tabId: null },
          ],
          { placeHolder: "Open a browser of this thread", matchOnDescription: true },
        );
        if (picked !== undefined) await open(picked.tabId);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.closePreviewSession",
          title: { value: "Close Browser Session", original: "Close Browser Session" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          precondition: ThreadSelectedContext,
        });
      }

      async run(
        accessor: ServicesAccessor,
        environmentId?: unknown,
        threadId?: unknown,
        tabId?: unknown,
      ): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const notifications = accessor.get(INotificationService);
        const thread =
          typeof environmentId === "string" && typeof threadId === "string"
            ? { environmentId, threadId }
            : targetThread();
        if (thread === undefined) return;
        if (typeof tabId === "string")
          return endSession(thread.environmentId, thread.threadId, tabId);
        const { sessions } = await loadedSessions(thread.environmentId, thread.threadId);
        if (sessions.length === 0)
          return notifications.info("This thread has no browser sessions.");
        const picked = await quickInput.pick(
          sessions.map((session) => ({
            label: session.label,
            description: [session.url, OWNER_LABELS[session.owner]]
              .filter((part) => part !== null)
              .join(" · "),
            tabId: session.tabId,
          })),
          { placeHolder: "Close a browser session of this thread", matchOnDescription: true },
        );
        if (picked !== undefined)
          await endSession(thread.environmentId, thread.threadId, picked.tabId);
      }
    },
  );
}

/** The thread a command names, selected first when it is not the selection's, else the selection's. */
async function namedThread(
  environmentId: unknown,
  threadId: unknown,
): Promise<ThreadSelection | undefined> {
  if (typeof environmentId !== "string" || typeof threadId !== "string") return targetThread();
  if (!isTarget(environmentId, threadId)) await selectThread(environmentId, threadId);
  return isTarget(environmentId, threadId) ? { environmentId, threadId } : undefined;
}

/**
 * Once the workbench is up and the selection restored: a closed tab ends its
 * session by its owner (a user's close alone: not a switch's, a move's, a
 * replacement's or the shell's own); the sessions of the threads with tabs and
 * of the selection's thread are followed, closing stale tabs and opening the
 * selection's pending reveals; and another thread's tabs leave the part.
 */
export async function startPreviewTabs(): Promise<void> {
  const editors = await getService(IEditorService);
  editors.onDidCloseEditor(({ editor, context }) => {
    if (!(editor instanceof PreviewInput) || context !== EditorCloseContext.UNKNOWN) return;
    if (isSwitchingThread() || closingByShell.has(editor)) return;
    void closedByUser(editor).catch((error: unknown) =>
      console.error("[pult-shell] the browser session did not close", error),
    );
  });
  editors.onDidEditorsChange(() => void refreshFollows());
  const selectionChanged = () => {
    void refreshFollows();
    void enqueue(closeForeignTabs);
    // A reveal remembered while the thread was switched to, or away from and back, opens now, not on its list's next change.
    const target = targetThread();
    if (target !== undefined)
      void currentSessions(target.environmentId, target.threadId).then(({ loaded, sessions }) => {
        if (loaded)
          openRemembered(
            target.environmentId,
            target.threadId,
            sessions.map((session) => session.tabId),
          );
      });
  };
  onDidSelectThread(selectionChanged);
  // A selected Star's conversation is the selection's thread, and it changes as the Stars do.
  let starTarget = targetThread();
  starStore.subscribe(() => {
    const next = targetThread();
    if (
      next?.environmentId === starTarget?.environmentId &&
      next?.threadId === starTarget?.threadId
    )
      return;
    starTarget = next;
    selectionChanged();
  });
  selectionChanged();
  passDragsOverWebviews();
}

/**
 * While a drag runs in the page (a tab dragged to another group or a split),
 * the hosted webviews let the pointer through (`pult-dragging`,
 * `src/style.css`): a guest page under the pointer would take the drag's
 * events, and the editor group under it would show no drop zone. Marked on
 * the drag's first `drag` event, which only a drag that started fires (a
 * `dragstart` a handler cancels, the workbench's select boxes or upstream's
 * sidebar, starts none), and cleared at its end, its drop, or the next press
 * of the pointer, should neither arrive.
 */
function passDragsOverWebviews(): void {
  const dragging = (on: boolean) => () => {
    if (document.body.classList.contains("pult-dragging") !== on)
      document.body.classList.toggle("pult-dragging", on);
  };
  document.addEventListener("drag", dragging(true), true);
  for (const end of ["dragend", "drop", "pointerdown"])
    document.addEventListener(end, dragging(false), true);
}
