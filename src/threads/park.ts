import { getService, ICommandService, IContextKeyService, IQuickInputService, type ServicesAccessor } from "@codingame/monaco-vscode-api";
import { type IAction, Separator, SubmenuAction, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";

import { nextAfterParking, type ParkActions, parkActions } from "./parking.ts";
import { onDidSelectThread, selectedThread, selectThread } from "./selection.ts";
import { type ShellThread, threadStore } from "./store.ts";

/**
 * Settling, snoozing and pinning threads from the shell: the cards' hover
 * actions and context menu (`src/panel/PanelView.tsx`) and the palette, on
 * the selected thread. The extension does each through its `pult.*Thread`
 * commands, given the thread's id; the shell moves the selection on when the
 * selected thread is parked, as upstream's sidebar does.
 */

/** `pult.snoozeThread`'s wake that asks for a custom one, in the extension's input box. */
const CUSTOM_WAKE = "custom";

/** Threads whose settle or snooze is under way, which the selection does not move to. */
const parking = new Set<string>();

function thread(threadId: string): ShellThread | undefined {
  return threadStore.get().threads.find((candidate) => candidate.id === threadId);
}

async function execute(command: string, ...args: unknown[]): Promise<unknown> {
  const commands = await getService(ICommandService);
  return commands.executeCommand(command, ...args).catch((error: unknown) => console.error(`[pult-shell] ${command} failed`, error));
}

/**
 * `pult-shell.newThread <projectId>`, a draft in the project. Missing until
 * the shell has it, which leaves the selection where it was.
 */
function newThreadIn(projectId: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.newThread", projectId).catch(() => undefined));
}

/**
 * Settles or snoozes a thread: `wake` an ISO time, `custom` for the
 * extension's input box, or undefined for settling. When it was the selected
 * thread and still is once parked, the selection moves to the next card after
 * it, chosen before the list changes, or with none to a new thread in its
 * project; parking another thread leaves the selection alone.
 */
async function park(threadId: string, wake?: string): Promise<void> {
  if (parking.has(threadId)) return;
  const parked = thread(threadId);
  const next =
    selectedThread()?.threadId === threadId ? nextAfterParking(threadStore.get().threads, threadId, parking) : undefined;
  parking.add(threadId);
  let done: unknown;
  try {
    done =
      wake === undefined ? await execute("pult.settleThread", threadId) : await execute("pult.snoozeThread", threadId, wake);
  } finally {
    parking.delete(threadId);
  }
  // The extension's command resolves to true once the thread is parked.
  if (done !== true || next === undefined || selectedThread()?.threadId !== threadId) return;
  if (next !== null) await selectThread(next);
  else if (parked !== undefined) newThreadIn(parked.projectId);
}

export const settleThread = (threadId: string) => park(threadId);
export const snoozeThread = (threadId: string, wake: string) => park(threadId, wake);
export const unsettleThread = (threadId: string) => void execute("pult.unsettleThread", threadId);
export const wakeThread = (threadId: string) => void execute("pult.unsnoozeThread", threadId);
export const pinThread = (threadId: string) => void execute("pult.pinThread", threadId);
export const unpinThread = (threadId: string) => void execute("pult.unpinThread", threadId);

/** What a thread offers now, under the server's features. */
export function threadParkActions(target: ShellThread): ParkActions {
  return parkActions(target, threadStore.get().features);
}

/** Upstream's snooze presets, each with its time, then Custom…, which asks the extension for one. */
function snoozeActions(threadId: string): IAction[] {
  return [
    ...resolveSnoozePresets(new Date()).map((preset) =>
      toAction({
        id: `pult-shell.snooze.${preset.id}`,
        label: `${preset.label} (${preset.whenLabel})`,
        run: () => snoozeThread(threadId, preset.snoozedUntil),
      }),
    ),
    new Separator(),
    toAction({ id: "pult-shell.snooze.custom", label: "Custom…", run: () => snoozeThread(threadId, CUSTOM_WAKE) }),
  ];
}

type Anchor = HTMLElement | { x: number; y: number };

/** The card's clock: the snooze presets under it. `onHide` once the menu closes. */
export async function showSnoozeMenu(threadId: string, anchor: HTMLElement, onHide: () => void): Promise<void> {
  const menus = await getService(IContextMenuService);
  menus.showContextMenu({ getAnchor: () => anchor, getActions: () => snoozeActions(threadId), onHide });
}

/**
 * A card's context menu, as upstream's thread menu: Pin or Unpin, Settle or
 * Un-settle, Snooze's presets or Wake, then New Thread in Project.
 */
export async function showThreadMenu(target: ShellThread, anchor: Anchor): Promise<void> {
  const menus = await getService(IContextMenuService);
  const offered = threadParkActions(target);
  const action = (id: string, label: string, run: () => unknown) => toAction({ id: `pult-shell.${id}`, label, run });
  const actions = [
    offered.pin ? action("pinThread", "Pin Thread", () => pinThread(target.id)) : null,
    offered.unpin ? action("unpinThread", "Unpin Thread", () => unpinThread(target.id)) : null,
    offered.settle ? action("settleThread", "Settle Thread", () => settleThread(target.id)) : null,
    offered.unsettle ? action("unsettleThread", "Un-settle Thread", () => unsettleThread(target.id)) : null,
    offered.snooze
      ? target.canSnooze
        ? new SubmenuAction("pult-shell.snoozeThread", "Snooze", snoozeActions(target.id))
        : toAction({ id: "pult-shell.snoozeThread", label: "Snooze", enabled: false, run: () => undefined })
      : null,
    offered.wake ? action("wakeThread", "Wake Thread", () => wakeThread(target.id)) : null,
  ].filter((each) => each !== null);
  menus.showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      ...actions,
      ...(actions.length > 0 ? [new Separator()] : []),
      action("newThreadInProject", "New Thread in Project", () => newThreadIn(target.projectId)),
    ],
  });
}

/** What the selected thread offers, as context keys for the palette's commands. */
const CONTEXT_KEYS = {
  settle: new RawContextKey<boolean>("pult.selectedThreadCanSettle", false),
  unsettle: new RawContextKey<boolean>("pult.selectedThreadCanUnsettle", false),
  snooze: new RawContextKey<boolean>("pult.selectedThreadCanSnooze", false),
  wake: new RawContextKey<boolean>("pult.selectedThreadCanWake", false),
  pin: new RawContextKey<boolean>("pult.selectedThreadCanPin", false),
  unpin: new RawContextKey<boolean>("pult.selectedThreadCanUnpin", false),
} satisfies Record<keyof ParkActions, RawContextKey<boolean>>;

/**
 * The palette's thread commands, on the selected thread, each offered while
 * the thread's shelf and the server allow it: Pult: Settle Thread,
 * Un-settle Thread, Snooze Thread… (a pick of the presets), Wake Thread,
 * Pin Thread, Unpin Thread. No keybinding: the thread view handles its own
 * Cmd+Shift+S (upstream's `thread.settle`) on the page's window.
 */
export function registerParkCommands(): void {
  const selected = () => {
    const id = selectedThread()?.threadId;
    return id === undefined ? undefined : thread(id);
  };
  const command = (key: keyof ParkActions, id: string, title: string, run: (target: ShellThread, accessor: ServicesAccessor) => unknown) =>
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id,
            title: { value: title, original: title },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            precondition: CONTEXT_KEYS[key],
          });
        }

        async run(accessor: ServicesAccessor): Promise<void> {
          const target = selected();
          if (target !== undefined) await run(target, accessor);
        }
      },
    );
  command("settle", "pult-shell.settleThread", "Settle Thread", (target) => settleThread(target.id));
  command("unsettle", "pult-shell.unsettleThread", "Un-settle Thread", (target) => unsettleThread(target.id));
  command("snooze", "pult-shell.snoozeThread", "Snooze Thread…", async (target, accessor) => {
    const quickInput = accessor.get(IQuickInputService);
    const picked = await quickInput.pick(
      [
        ...resolveSnoozePresets(new Date()).map((preset) => ({ label: preset.label, description: preset.whenLabel, wake: preset.snoozedUntil })),
        { label: "Custom…", wake: CUSTOM_WAKE },
      ],
      { placeHolder: "Snooze until" },
    );
    if (picked !== undefined) await snoozeThread(target.id, picked.wake);
  });
  command("wake", "pult-shell.wakeThread", "Wake Thread", (target) => wakeThread(target.id));
  command("pin", "pult-shell.pinThread", "Pin Thread", (target) => pinThread(target.id));
  command("unpin", "pult-shell.unpinThread", "Unpin Thread", (target) => unpinThread(target.id));

  void getService(IContextKeyService).then((contextKeys) => {
    const keys = Object.entries(CONTEXT_KEYS).map(([action, key]) => [action as keyof ParkActions, key.bindTo(contextKeys)] as const);
    const update = () => {
      const target = selected();
      for (const [action, key] of keys) {
        key.set(target !== undefined && threadParkActions(target)[action] && (action !== "snooze" || target.canSnooze));
      }
    };
    threadStore.subscribe(update);
    onDidSelectThread(update);
    update();
  });
}
