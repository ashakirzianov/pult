import {
  getService,
  IClipboardService,
  ICommandService,
  IContextKeyService,
  INotificationService,
  IQuickInputService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { type IAction, Separator, SubmenuAction, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import * as Operations from "@t3tools/client-runtime/operations";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { connection } from "../connection/index.ts";
import { nextAfterParking, type ParkActions, parkActions, parseCustomSnooze } from "./parking.ts";
import { onDidSelectThread, selectedThread, selectThread } from "./selection.ts";
import { type ShellThread, type ThreadFeatures, threadStore } from "./store.ts";

/**
 * Settling, snoozing and pinning threads from the shell, and copying a
 * thread's link: the cards' hover actions and context menu
 * (`src/panel/PanelView.tsx`) and the palette, on the selected thread. Each
 * runs upstream's command through `@t3tools/client-runtime/operations` on the
 * page's connection, as pult-extension's `src/threads/commands.ts` did; the
 * shell moves the selection on when the selected thread is parked, as
 * upstream's sidebar does.
 */

/** A snooze's wake that asks the user for a custom one. */
const CUSTOM_WAKE = "custom";

const FEATURE_NAMES: Record<keyof ThreadFeatures, string> = {
  settlement: "settling threads",
  snooze: "snoozing threads",
  pinning: "pinning threads",
};

// The thread commands mint their command ids with it.
const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
    }),
});

type Command = { readonly threadId: ThreadId };

/** Runs a thread command on the environment's live session. */
function run<A, E>(effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | Crypto.Crypto>): Promise<A> {
  return connection.run(effect.pipe(Effect.provideService(Crypto.Crypto, webCrypto)));
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

/** Threads whose settle or snooze is under way, which the selection does not move to. */
const parking = new Set<string>();

function thread(threadId: string): ShellThread | undefined {
  return threadStore.get().threads.find((candidate) => candidate.id === threadId);
}

/**
 * Does `action` to a thread the store knows, when the server has `feature`
 * (`pult/decisions`, `capability-gated-rpcs`: a server that does not
 * advertise it never gets its commands). Resolves to whether it was carried
 * out: false when it failed, which a notification says, or the user cancelled
 * it, the action resolving to false.
 */
async function act(threadId: string, feature: keyof ThreadFeatures, action: (command: Command) => Promise<unknown>): Promise<boolean> {
  const notifications = await getService(INotificationService);
  if (thread(threadId) === undefined) {
    notifications.info("Pult: select a thread first.");
    return false;
  }
  if (!threadStore.get().features[feature]) {
    notifications.error(`Pult: this environment's server does not support ${FEATURE_NAMES[feature]}.`);
    return false;
  }
  try {
    return (await action({ threadId: ThreadId.make(threadId) })) !== false;
  } catch (error) {
    console.error(error);
    notifications.error(`Pult: ${errorMessage(error)}`);
    return false;
  }
}

/** A custom wake, typed in the shell's input box: a duration or a local time. */
async function customWake(): Promise<string | undefined> {
  const quickInput = await getService(IQuickInputService);
  const text = await quickInput.input({
    title: "Snooze until",
    prompt: "A duration such as 45m, 2h or 3d, or a local time such as 2026-10-20 09:00",
    validateInput: async (value) =>
      value.trim() !== "" && parseCustomSnooze(value, new Date()) === null
        ? "Enter a future time: 45m, 2h, 3d, or YYYY-MM-DD HH:MM."
        : undefined,
  });
  return text === undefined ? undefined : (parseCustomSnooze(text, new Date()) ?? undefined);
}

/**
 * `pult-shell.newThread <projectId>`, a draft in the project. Missing until
 * the shell has it, which leaves the selection where it was.
 */
function newThreadIn(projectId: string): void {
  void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.newThread", projectId).catch(() => undefined));
}

/**
 * Settles or snoozes a thread: `wake` an ISO time, `custom` for the user's
 * own, or undefined for settling. When it was the selected thread and still
 * is once parked, the selection moves to the next card after it, chosen
 * before the list changes, or with none to a new thread in its project;
 * parking another thread leaves the selection alone.
 */
async function park(threadId: string, wake?: string): Promise<void> {
  if (parking.has(threadId)) return;
  const parked = thread(threadId);
  const next =
    selectedThread()?.threadId === threadId ? nextAfterParking(threadStore.get().threads, threadId, parking) : undefined;
  parking.add(threadId);
  let done = false;
  try {
    done =
      wake === undefined
        ? await act(threadId, "settlement", (command) => run(Operations.settleThread(command)))
        : await act(threadId, "snooze", async (command) => {
            const snoozedUntil = wake === CUSTOM_WAKE ? await customWake() : wake;
            if (snoozedUntil === undefined) return false;
            return run(Operations.snoozeThread({ ...command, snoozedUntil }));
          });
  } finally {
    parking.delete(threadId);
  }
  if (!done || next === undefined || selectedThread()?.threadId !== threadId) return;
  if (next !== null) await selectThread(next);
  else if (parked !== undefined) newThreadIn(parked.projectId);
}

export const settleThread = (threadId: string) => park(threadId);
export const snoozeThread = (threadId: string, wake: string) => park(threadId, wake);
export const unsettleThread = (threadId: string) =>
  void act(threadId, "settlement", (command) => run(Operations.unsettleThread({ ...command, reason: "user" })));
export const wakeThread = (threadId: string) =>
  void act(threadId, "snooze", (command) => run(Operations.unsnoozeThread({ ...command, reason: "user" })));
export const pinThread = (threadId: string) => void act(threadId, "pinning", (command) => run(Operations.pinThread(command)));
export const unpinThread = (threadId: string) =>
  void act(threadId, "pinning", (command) => run(Operations.unpinThread(command)));

/** Copies the thread's link in the environment's own web app, where any browser can follow it. */
async function copyThreadLink(threadId: string): Promise<void> {
  const notifications = await getService(INotificationService);
  const environment = connection.environment;
  const target = thread(threadId);
  if (target === undefined || environment === null || environment.httpBaseUrl === "") {
    notifications.info("Pult: select a thread first.");
    return;
  }
  const link = new URL(`/${environment.environmentId}/${target.id}`, environment.httpBaseUrl);
  await (await getService(IClipboardService)).writeText(link.toString());
  notifications.info(`Copied the link to ${target.title}.`);
}

/** What a thread offers now, under the server's features. */
export function threadParkActions(target: ShellThread): ParkActions {
  return parkActions(target, threadStore.get().features);
}

/** Upstream's snooze presets, each with its time, then Custom…, which asks the user for one. */
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
 * Un-settle, Snooze's presets or Wake, then Copy Thread Link and New Thread in
 * Project.
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
      action("copyThreadLink", "Copy Thread Link", () => copyThreadLink(target.id)),
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

/** Whether a thread the store knows is selected, for Copy Thread Link. */
const ThreadSelectedContext = new RawContextKey<boolean>("pult.selectedThreadKnown", false);

/**
 * The palette's thread commands, on the selected thread, each offered while
 * the thread's shelf and the server allow it: Pult: Settle Thread,
 * Un-settle Thread, Snooze Thread… (a pick of the presets), Wake Thread,
 * Pin Thread, Unpin Thread, and Copy Thread Link. No keybinding: the thread
 * view handles its own Cmd+Shift+S (upstream's `thread.settle`) on the page's
 * window.
 */
export function registerParkCommands(): void {
  const selected = () => {
    const id = selectedThread()?.threadId;
    return id === undefined ? undefined : thread(id);
  };
  const command = (
    precondition: RawContextKey<boolean>,
    id: string,
    title: string,
    run: (target: ShellThread, accessor: ServicesAccessor) => unknown,
  ) =>
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id,
            title: { value: title, original: title },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            precondition,
          });
        }

        async run(accessor: ServicesAccessor): Promise<void> {
          const target = selected();
          if (target !== undefined) await run(target, accessor);
        }
      },
    );
  command(CONTEXT_KEYS.settle, "pult-shell.settleThread", "Settle Thread", (target) => settleThread(target.id));
  command(CONTEXT_KEYS.unsettle, "pult-shell.unsettleThread", "Un-settle Thread", (target) => unsettleThread(target.id));
  command(CONTEXT_KEYS.snooze, "pult-shell.snoozeThread", "Snooze Thread…", async (target, accessor) => {
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
  command(CONTEXT_KEYS.wake, "pult-shell.wakeThread", "Wake Thread", (target) => wakeThread(target.id));
  command(CONTEXT_KEYS.pin, "pult-shell.pinThread", "Pin Thread", (target) => pinThread(target.id));
  command(CONTEXT_KEYS.unpin, "pult-shell.unpinThread", "Unpin Thread", (target) => unpinThread(target.id));
  command(ThreadSelectedContext, "pult-shell.copyThreadLink", "Copy Thread Link", (target) => copyThreadLink(target.id));

  void getService(IContextKeyService).then((contextKeys) => {
    const keys = Object.entries(CONTEXT_KEYS).map(([action, key]) => [action as keyof ParkActions, key.bindTo(contextKeys)] as const);
    const known = ThreadSelectedContext.bindTo(contextKeys);
    const update = () => {
      const target = selected();
      known.set(target !== undefined);
      for (const [action, key] of keys) {
        key.set(target !== undefined && threadParkActions(target)[action] && (action !== "snooze" || target.canSnooze));
      }
    };
    threadStore.subscribe(update);
    onDidSelectThread(update);
    update();
  });
}
