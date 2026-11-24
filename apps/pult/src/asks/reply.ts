// An ask opened, and the reply written under its file (Beta's
// `designs/ask-model.md`, Reply): the row selects the poster and opens the
// ask's file among its tabs, with the poster conversation's own composer under
// it in the composer strip (`src/composer/index.tsx`), its sends opening with
// the line the plugin serves and telling the plugin `replied` once sent.
import {
  getService,
  ICommandService,
  IInstantiationService,
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
import { channelModel, starById, starStore, starTarget } from "../stars/model.ts";
import { starEnabled } from "../stars/settings.ts";
import { afterDraftWake } from "../stars/tab.tsx";
import { StarThreadInput } from "../threads/pane.tsx";
import { selectStar, selectThread, selectedStar, selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { type PageAsk, posterName, shownAsks } from "./asks.ts";
import { actOnPageAsk, askById, askStore } from "./model.ts";

/** The ask being replied to: its file, a `pult:` resource, while its row last opened it, and how many times rows were opened, which a new composer is mounted for. */
let replying:
  | {
      readonly environmentId: string;
      readonly id: string;
      readonly resource: string;
      readonly opened: number;
    }
  | undefined;
let opened = 0;
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
const posterOf = (ask: PageAsk) =>
  posterName(
    ask,
    starById,
    (environmentId, threadId) =>
      threadStore
        .get()
        .threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId)
        ?.title,
  );

/** An accepted reply marks the posting it answered, provided it landed on the same environment. */
async function replied(ask: PageAsk, environmentId: string): Promise<void> {
  if (environmentId !== ask.environmentId)
    return void (await getService(INotificationService)).warn(
      `The reply to “${ask.title}” went to another environment than the one that asked, so the ask stays in Inbox.`,
    );
  if (askById(ask.environmentId, ask.id)?.posted !== ask.posted) return;
  await actOnPageAsk(ask, { kind: "replied" });
}

/** Open the thread that accepted the send, even if its Star has another channel or home open. */
async function openReplyThread(
  poster: PageAsk["poster"],
  environmentId: string,
  threadId: string,
): Promise<void> {
  if ("thread" in poster) return selectThread(environmentId, threadId);

  const star = starById(poster.star);
  if (star === undefined) return selectThread(environmentId, threadId);
  await selectStar(star.id);
  if (selectedStar() !== star.id) return;
  const current = starById(star.id) ?? star;
  const lead = starTarget(current);
  if (lead?.kind === "thread" && lead.environmentId === environmentId && lead.threadId === threadId)
    return;

  const [editors, instantiation] = await Promise.all([
    getService(IEditorService),
    getService(IInstantiationService),
  ]);
  // The channel's tab, as its row opens it, following the channel on this environment.
  await editors.openEditor(
    instantiation.createInstance(StarThreadInput, environmentId, threadId, poster.channel, star.id),
    { revealIfOpened: true },
  );
}

const NO_SUGGESTIONS: ReadonlyArray<string> = [];

/** The options its poster suggests, while the posting this composer answers is neither replied to nor settled. */
const replySuggestions = (ask: PageAsk) => ({
  get: () => {
    const now = askById(ask.environmentId, ask.id);
    return now?.posted === ask.posted && now.replied === null && now.settled === null
      ? now.replies
      : NO_SUGGESTIONS;
  },
  subscribe: askStore.subscribe,
});

/**
 * The composer a reply to the ask is written in: a thread's own; a Star's
 * posting channel's conversation on the ask's environment, or while that
 * channel sleeps there its draft, tagged `pult:channel:<slug>`
 * (`view/drafts.ts`), the default channel's being the Star's own, at the
 * model the Star chose for it. Undefined where the page does not hold it.
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
  // The home's own reading, which knows the channel open there whatever another home has open.
  const open = home.channels.find((each) => each.slug === channel);
  if (open !== undefined)
    return {
      target: { kind: "thread", environmentId, threadId: open.threadId } satisfies ViewTarget,
      options: {},
    };
  return {
    target: {
      kind: "draft",
      environmentId,
      projectId: home.projectId,
      tags: [`pult:channel:${channel}`],
    } satisfies ViewTarget,
    options: {
      draftHero: false,
      // The route serves the default channel's model; another channel's is asked for.
      draftModel:
        channel === star.defaultChannel
          ? {
              get: () =>
                starById(starId)?.homes.find((each) => each.environmentId === environmentId)
                  ?.model ?? null,
              subscribe: starStore.subscribe,
            }
          : channelModel(starId, environmentId, channel),
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
  const key = JSON.stringify([
    replying.opened,
    ask.environmentId,
    ask.id,
    ask.prefix,
    found.target,
  ]);
  let options = kept.get(key);
  if (options === undefined) {
    const { target } = found;
    // While a sleeping channel's thread is being created by the send, which no tab can show yet.
    let sending = false;
    const sendingListeners = new Set<() => void>();
    const setSending = (value: boolean) => {
      sending = value;
      for (const listener of sendingListeners) listener();
    };
    const openThread = (environmentId: string, threadId: string) =>
      void openReplyThread(ask.poster, environmentId, threadId).catch(async (error: unknown) => {
        (await getService(INotificationService)).error(
          `Pult could not open the reply's thread: ${String(error)}`,
        );
      });
    options = {
      ...found.options,
      placeholder: {
        get: () => (sending ? "Sending…" : `Reply to ${posterOf(ask)}`),
        subscribe: (listener) => {
          sendingListeners.add(listener);
          const stop = starStore.subscribe(listener);
          return () => {
            sendingListeners.delete(listener);
            stop();
          };
        },
      },
      reply: {
        prefix: ask.prefix,
        suggestions: replySuggestions(ask),
        // An awake thread's tab opens as the send starts; a draft's thread opens once the send creates it.
        sending: (sentOn, threadId) => {
          if (target.kind === "thread") return openThread(sentOn, threadId);
          setSending(true);
          void import("../../view/drafts.ts").then(({ draftSending, onDidChangeComposers }) => {
            const settle = () => {
              if (draftSending(target.environmentId, target.projectId, target.tags)) return;
              setSending(false);
              stop();
            };
            const stop = onDidChangeComposers(settle);
            settle();
          });
        },
        sent: (sentOn, threadId) => {
          if (target.kind === "draft" && "star" in ask.poster)
            void afterDraftWake(ask.poster.star, sentOn, threadId, ask.poster.channel);
          void replied(ask, sentOn);
          if (target.kind === "draft") openThread(sentOn, threadId);
        },
      },
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
  // A composer of its own each time it is opened, at the channel's model as the Star chooses it now.
  replying = {
    environmentId: ask.environmentId,
    id: ask.id,
    resource: resource.toString(),
    opened: ++opened,
  };
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
