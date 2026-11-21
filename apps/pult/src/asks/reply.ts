// An ask opened, and the reply written under its file (Beta's
// `designs/ask-model.md`, Reply): the row selects the poster and opens the
// ask's file among its tabs, with the poster conversation's own composer under
// it in the composer strip (`src/composer/index.tsx`), its sends opening with
// the line the plugin serves and telling the plugin `replied` once sent.
import {
  getService,
  ICommandService,
  INotificationService,
  IQuickInputService,
} from "@codingame/monaco-vscode-api";
import { Emitter } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import type { MountOptions, ViewTarget } from "../../view/main.tsx";
import { connection } from "../connection/index.ts";
import { toUriPath } from "../files/paths.ts";
import { pultResource } from "../files/workspace.ts";
import { starById, starStore, starWakeModel } from "../stars/model.ts";
import type { RouteModel } from "../stars/plugin.ts";
import { USER_CHANNEL } from "../stars/plugin.ts";
import { starEnabled } from "../stars/settings.ts";
import { starName } from "../stars/stars.ts";
import { afterDraftWake } from "../stars/tab.tsx";
import { selectedStar, selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { type PageAsk, posterName, shownAsks } from "./asks.ts";
import { actOnPageAsk, askById, askStore } from "./model.ts";

/** The runtime mode a channel's draft asks its model at before it is sent, upstream's default. */
const DRAFT_RUNTIME_MODE = "full-access";

/** The ask being replied to: its file, a `pult:` resource, while its row last opened it. */
let replying:
  | { readonly environmentId: string; readonly id: string; readonly resource: string }
  | undefined;
const onDidChangeReplying = new Emitter<void>();
export const onDidChangeReply = onDidChangeReplying.event;

/** The composer the strip shows for a reply: its key, which a new mount takes, its target and its mount's options. */
export interface ReplyComposer {
  readonly key: string;
  readonly target: ViewTarget;
  readonly options: MountOptions;
}

/** Each reply's options, kept so a mount sees the same ones for the same ask and target. */
const kept = new Map<string, MountOptions>();
/** Each sleeping channel's model, as its home's plugin chose it, by Star, environment and channel; null until read, or for the page's own. */
const channelModels = new Map<string, { value: RouteModel | null; listeners: Set<() => void> }>();

/** The model a channel's draft wakes it at, read once from its home's plugin (`POST stars/<id>/model`). */
function channelModel(starId: string, environmentId: string, channel: string) {
  const key = JSON.stringify([starId, environmentId, channel]);
  let entry = channelModels.get(key);
  if (entry === undefined) {
    const created = { value: null as RouteModel | null, listeners: new Set<() => void>() };
    entry = created;
    channelModels.set(key, created);
    void starWakeModel(starId, environmentId, DRAFT_RUNTIME_MODE, channel).then((model) => {
      created.value = model;
      for (const listener of created.listeners) listener();
    });
  }
  const found = entry;
  return {
    get: () => found.value,
    subscribe: (listener: () => void) => {
      found.listeners.add(listener);
      return () => found.listeners.delete(listener);
    },
  };
}

const posterOf = (ask: PageAsk) =>
  posterName(
    ask,
    (starId) => {
      const star = starById(starId);
      return star === undefined ? undefined : starName(star);
    },
    (environmentId, threadId) =>
      threadStore
        .get()
        .threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId)
        ?.title,
  );

/** The reply's send told to the plugin, which moves the ask to Working; the strip goes back to the selection's composer. */
function replied(ask: PageAsk): void {
  if (replying?.environmentId === ask.environmentId && replying.id === ask.id) {
    replying = undefined;
    onDidChangeReplying.fire();
  }
  void actOnPageAsk(ask, { kind: "replied" });
}

/**
 * The composer a reply to the ask is written in: a thread's own; a Star's
 * posting channel's conversation on the ask's environment, or while that
 * channel sleeps there its draft, `user`'s the Star's own and any other's
 * tagged `pult:channel:<slug>` (`view/drafts.ts`), at the model the Star
 * chose for it. Undefined where the page does not hold it.
 */
function replyTarget(ask: PageAsk) {
  const environmentId = ask.environmentId;
  if ("thread" in ask.poster)
    return {
      target: { kind: "thread", environmentId, threadId: ask.poster.thread } satisfies ViewTarget,
      options: {},
    };
  const { star: starId, channel } = ask.poster;
  const star = starById(starId);
  const home = star?.homes.find((each) => each.environmentId === environmentId);
  if (star === undefined || home === undefined) return undefined;
  const open = star.channels.find(
    (each) => each.slug === channel && each.thread.environmentId === environmentId,
  );
  if (open !== undefined)
    return {
      target: { kind: "thread", environmentId, threadId: open.thread.id } satisfies ViewTarget,
      options: {},
    };
  const user = channel === USER_CHANNEL;
  return {
    target: {
      kind: "draft",
      environmentId,
      projectId: home.projectId,
      ...(user ? {} : { tags: [`pult:channel:${channel}`] }),
    } satisfies ViewTarget,
    options: {
      draftHero: false,
      draftModel: user
        ? {
            get: () =>
              starById(starId)?.homes.find((each) => each.environmentId === environmentId)?.model ??
              null,
            subscribe: starStore.subscribe,
          }
        : channelModel(starId, environmentId, channel),
      draftSent: (sentOn: string, threadId: string) =>
        void afterDraftWake(starId, sentOn, threadId, user ? undefined : channel),
    } satisfies MountOptions,
  };
}

/**
 * The reply's composer while the active editor is the file of the ask its
 * row last opened and the selection is still its poster's (the thread, or
 * the Star); null otherwise, when the strip shows the selection's composer.
 */
export function replyComposer(activeResource: string | undefined): ReplyComposer | null {
  if (replying === undefined || activeResource !== replying.resource) return null;
  const ask = askById(replying.environmentId, replying.id);
  if (ask === undefined || connection.environment(ask.environmentId) === undefined) return null;
  const selection = selectionTarget();
  const selected =
    "thread" in ask.poster
      ? selection !== undefined &&
        "threadId" in selection &&
        selection.environmentId === ask.environmentId &&
        selection.threadId === ask.poster.thread
      : selectedStar() === ask.poster.star;
  if (!selected) return null;
  const found = replyTarget(ask);
  if (found === undefined) return null;
  const key = JSON.stringify([ask.environmentId, ask.id, ask.prefix, found.target]);
  let options = kept.get(key);
  if (options === undefined) {
    options = {
      ...found.options,
      placeholder: { get: () => `Reply to ${posterOf(ask)}`, subscribe: starStore.subscribe },
      reply: { prefix: ask.prefix, sent: () => replied(ask) },
    };
    kept.clear();
    kept.set(key, options);
  }
  return { key, target: found.target, options };
}

/** One of the asks Inbox, Working and Snoozed show, picked by its title; none while there is none. */
async function pickAsk(): Promise<PageAsk | undefined> {
  const asks = shownAsks(askStore.get(), starEnabled.get()).filter(
    (ask) => ask.status !== "settled",
  );
  if (asks.length === 0)
    return void (await getService(INotificationService)).info("Nothing is asked of you.");
  const quickInput = await getService(IQuickInputService);
  return (
    await quickInput.pick(
      asks.map((ask) => ({ ask, label: ask.title, description: posterOf(ask) })),
      { placeHolder: "Open an ask" },
    )
  )?.ask;
}

/**
 * Opens the ask as its row does (`pult-shell.openAsk <environmentId> <id>`,
 * the palette's Pult: Open Ask… picking one without them):
 * its poster selected, the thread or the Star, its file among the poster's
 * tabs, a named file in the poster's checkout and Pult's Markdown in the
 * asks folder, and the composer strip shown, the reply's composer under it.
 */
async function openAsk(environmentId: unknown, id: unknown): Promise<void> {
  const notifications = await getService(INotificationService);
  const ask =
    typeof environmentId === "string" && typeof id === "string"
      ? askById(environmentId, id)
      : await pickAsk();
  if (ask === undefined) {
    if (typeof id === "string") notifications.info("That ask is no longer there.");
    return;
  }
  const commands = await getService(ICommandService);
  if ("thread" in ask.poster) {
    await commands.executeCommand("pult-shell.selectThread", ask.environmentId, ask.poster.thread);
    const selection = selectionTarget();
    // A switch cancelled over a modified file leaves the selection as it was, so the ask is not opened among its tabs.
    if (
      selection === undefined ||
      !("threadId" in selection) ||
      selection.threadId !== ask.poster.thread
    )
      return;
  } else {
    if (starById(ask.poster.star) === undefined)
      return void notifications.info("The Star that asked is not on any environment Pult holds.");
    await commands.executeCommand("pult-shell.selectStar", ask.poster.star);
    if (selectedStar() !== ask.poster.star) return;
  }
  const resource = pultResource(ask.environmentId, toUriPath(ask.file));
  replying = { environmentId: ask.environmentId, id: ask.id, resource: resource.toString() };
  onDidChangeReplying.fire();
  await (await getService(IEditorService)).openEditor({ resource });
  await commands.executeCommand("pult-shell.showComposer");
}

/** `pult-shell.openAsk [environmentId] [id]`, the palette's Pult: Open Ask…. Registered before the workbench starts. */
export function registerAskCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openAsk",
          title: { value: "Open Ask…", original: "Open Ask…" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      run(_: unknown, environmentId?: unknown, id?: unknown): Promise<void> {
        return openAsk(environmentId, id);
      }
    },
  );
}
