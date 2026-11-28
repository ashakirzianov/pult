// Extensions' UI items on the page (`ui.ts`): every held environment whose server config says
// `extensionUi` followed on `extensions.subscribeUi`, resubscribed on each session, its lists
// forgotten while it is not ready; an item's action sent with `extensions.act`, a refusal told
// with the extension's words; a row opened as an ask was (`pult-shell.openExtensionRow`), its
// poster selected, its file among the poster's tabs and its reply's composer in the strip under
// it, a composer the extension handles (`extensions.send`), whose answer opens its thread.
import {
  getService,
  ICommandService,
  IInstantiationService,
  INotificationService,
} from "@codingame/monaco-vscode-api";
import { Emitter } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { MountOptions, ViewTarget } from "../../view/main.tsx";
import { connection } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import { toUriPath } from "../files/paths.ts";
import { pultResource } from "../files/workspace.ts";
import { posterName } from "../panel/poster.ts";
import type { RoutePoster } from "../stars/plugin.ts";
import { starById, starStore } from "../stars/model.ts";
import { StarInput, StarThreadInput } from "../threads/pane.tsx";
import { selectStar, selectThread, selectedStar, selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { ExtensionItems, type PageRow, replyLanding, replyMountKey, type Transport } from "./ui.ts";

function todo(reason: string): never {
  throw new Error(`todo: ${reason}`);
}

const items = new ExtensionItems(
  (message) => console.warn(`[pult-shell] ${message}`),
  () => connection.environments.map((environment) => environment.environmentId),
);

const transport: Transport = {
  act: (environmentId, input) =>
    connection.run(environmentId, request(WS_METHODS.extensionsAct, input)),
  send: (environmentId, input) =>
    connection.run(environmentId, request(WS_METHODS.extensionsSend, input)),
};

/** Every held environment's rows, in the environments' order. */
export const extensionRows = {
  get: () => items.rows(),
  subscribe: (listener: () => void) => items.subscribe(listener),
};

export const pendingAction = (page: PageRow) => items.pendingOf(page);

/** Whether the environment's rows are this connect's, the notices' baseline. */
export const rowsAnsweredOn = (environmentId: string) => items.answeredOn(environmentId);

/** The row's action, `value` its input's; a refusal notified, the row drawn as published. */
export async function actOnRow(page: PageRow, action: string, value?: string): Promise<void> {
  const refused = await items.act(transport, page, action, value);
  if (refused === null) return;
  const label = page.row.actions.find((each) => each.id === action)?.label ?? action;
  (await getService(INotificationService)).error(
    `Pult could not ${label.toLowerCase()} “${page.row.title}”: ${refused}`,
  );
}

/** A row's poster as the page's names read it: a `star-mark` as its Star and channel. */
export const rowPoster = (page: PageRow): RoutePoster =>
  "thread" in page.row.poster
    ? { thread: page.row.poster.thread }
    : {
        star: page.row.poster.star,
        channel:
          page.row.poster.channel ?? starById(page.row.poster.star)?.defaultChannel ?? "main",
      };

/** Starts following, after the connection and the thread model. */
export function startExtensionUi(): void {
  const followed = new Map<string, { stopConfig: () => void; stopUi: (() => void) | undefined }>();
  const sync = () => {
    for (const [environmentId, entry] of followed) {
      const environment = connection.environment(environmentId);
      if (environment !== undefined && environment.phase === "ready") continue;
      // Its stream sends the whole set again on the next session.
      items.forget(environmentId);
      if (environment !== undefined) continue;
      entry.stopConfig();
      entry.stopUi?.();
      followed.delete(environmentId);
    }
    for (const { environmentId } of connection.environments) {
      if (followed.has(environmentId)) continue;
      const entry = { stopConfig: () => {}, stopUi: undefined as (() => void) | undefined };
      followed.set(environmentId, entry);
      entry.stopConfig = followServerConfig(environmentId, (config) => {
        if (config.extensionUi !== true || entry.stopUi !== undefined) return;
        entry.stopUi = connection.follow(
          environmentId,
          subscribe(WS_METHODS.extensionsSubscribeUi, {}).pipe(
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                Effect.logError("[pult-shell] the extensions' UI items did not load", cause),
              ).pipe(Stream.drain),
            ),
          ),
          (published) => items.apply(environmentId, published),
        );
      });
    }
    items.reorder();
  };
  connection.onDidChange(sync);
  sync();
}

/**
 * Open the thread a reply landed in (`replyLanding`): a Star's default channel on the Star's tab, which
 * shows its newest conversation, another channel on its tab on this environment, even with another open.
 */
async function openPosterThread(
  poster: RoutePoster,
  environmentId: string,
  threadId: string,
): Promise<void> {
  const landing = replyLanding(poster, "star" in poster ? starById(poster.star) : undefined);
  if (landing.kind === "thread") return selectThread(environmentId, threadId);
  await selectStar(landing.star);
  if (selectedStar() !== landing.star) return;
  const [editors, instantiation] = await Promise.all([
    getService(IEditorService),
    getService(IInstantiationService),
  ]);
  // The Star's tab its selection just showed, or the channel's tab, as its row opens it, following the channel on this environment.
  await editors.openEditor(
    landing.kind === "star"
      ? (editors.editors.find(
          (editor) => editor instanceof StarInput && editor.starId === landing.star,
        ) ?? instantiation.createInstance(StarInput, landing.star))
      : instantiation.createInstance(
          StarThreadInput,
          environmentId,
          threadId,
          landing.slug,
          landing.star,
        ),
    { revealIfOpened: true },
  );
}

/** The row being replied to: its file while its row last opened it, and how many rows were opened, which a new composer is mounted for. */
let replying:
  | {
      readonly environmentId: string;
      readonly extension: string;
      readonly key: string;
      readonly resource: string;
      readonly opened: number;
    }
  | undefined;
let opened = 0;
const onDidChangeReplying = new Emitter<void>();
export const onDidChangeRowReply = onDidChangeReplying.event;

/** Each reply's options, kept so a mount sees the same ones for the same row and target. */
const kept = new Map<string, MountOptions>();

/** The composer a handled reply is written in: a draft of the target's project, one per row, that becomes no thread. */
function handledComposer(page: PageRow, key: string) {
  const target = page.row.open.reply?.target;
  if (target === undefined || !("handled" in target)) return undefined;
  const { handled } = target;
  const viewTarget = {
    kind: "draft",
    environmentId: page.environmentId,
    projectId: handled.project,
    tags: [`pult:handled:${page.extension}#${page.row.key}`],
  } satisfies ViewTarget;
  let options = kept.get(key);
  if (options === undefined) {
    const poster = rowPoster(page);
    const constant = <Value>(value: Value) => ({ get: () => value, subscribe: () => () => {} });
    const destination = {
      get: () => {
        const now = items.row(page.environmentId, page.extension, page.row.key) ?? page;
        const name = posterName(
          { environmentId: page.environmentId, poster },
          starById,
          (environmentId, threadId) => threadStore.thread(environmentId, threadId)?.title,
        );
        const settled =
          "thread" in poster &&
          threadStore.thread(page.environmentId, poster.thread)?.settled === true;
        const note = now.row.open.reply?.note ?? (settled ? "settled" : null);
        return { name, note, open: null };
      },
      subscribe: (listener: () => void) => {
        const stops = [
          items.subscribe(listener),
          starStore.subscribe(listener),
          threadStore.subscribe(listener),
        ];
        return () => stops.forEach((stop) => stop());
      },
    };
    // Kept while its strings are equal, as `useSyncExternalStore` needs.
    let shownDestination: ReturnType<typeof destination.get> | undefined;
    let shownChips: ReadonlyArray<string> = [];
    options = {
      draftHero: false,
      placeholder: constant(handled.placeholder ?? "Write your reply"),
      ...(handled.model == null ? {} : { draftModel: constant(handled.model) }),
      reply: {
        destination: {
          get: () => {
            const now = destination.get();
            if (shownDestination?.name !== now.name || shownDestination.note !== now.note)
              shownDestination = now;
            return shownDestination;
          },
          subscribe: destination.subscribe,
        },
        suggestions: {
          get: () => {
            const now = (
              items.row(page.environmentId, page.extension, page.row.key)?.row.open.reply?.chips ??
              []
            ).map((chip) => chip.text);
            if (JSON.stringify(now) !== JSON.stringify(shownChips)) shownChips = now;
            return shownChips;
          },
          subscribe: (listener) => items.subscribe(listener),
        },
      },
      send: async (message) => {
        // The row drawn ahead by its reply's `then`; the composer locked until the answer.
        const answer = await items.send(
          transport,
          { environmentId: page.environmentId, extension: page.extension, key: page.row.key },
          message,
        );
        void openPosterThread(poster, page.environmentId, answer.thread).catch(
          async (error: unknown) =>
            (await getService(INotificationService)).error(
              `Pult could not open the reply's thread: ${String(error)}`,
            ),
        );
        return answer;
      },
    } satisfies MountOptions;
    kept.clear();
    kept.set(key, options);
  }
  return { target: viewTarget, options };
}

/**
 * The reply's composer while the active editor is the file of the row its click last opened and
 * the selection is still its poster's; null otherwise, when the strip shows the selection's.
 */
export function rowComposer(
  activeResource: string | undefined,
): { readonly key: string; readonly target: ViewTarget; readonly options: MountOptions } | null {
  if (replying === undefined || activeResource !== replying.resource) return null;
  const page = items.row(replying.environmentId, replying.extension, replying.key);
  const target = page?.row.open.reply?.target;
  if (page === undefined || target === undefined) return null;
  const poster = rowPoster(page);
  const selection = selectionTarget();
  const selected =
    "thread" in poster
      ? selection !== undefined &&
        "threadId" in selection &&
        selection.environmentId === page.environmentId &&
        selection.threadId === poster.thread
      : selectedStar() === poster.star;
  if (!selected) return null;
  if ("thread" in target) todo("a reply in a thread's own composer, `{ thread }`");
  // A republish with the same target keeps the mount; a new target mounts anew.
  const key = replyMountKey(replying.opened, page);
  const found = handledComposer(page, key);
  return found === undefined ? null : { key, ...found };
}

/**
 * Opens the row as its click does (`pult-shell.openExtensionRow <environmentId> <extension> <key>`):
 * its poster selected, the thread or the Star, its file among the poster's tabs, and the composer
 * strip shown with its reply's composer under it.
 */
async function openRow(environmentId: unknown, extension: unknown, key: unknown): Promise<void> {
  const notifications = await getService(INotificationService);
  const page =
    typeof environmentId === "string" && typeof extension === "string" && typeof key === "string"
      ? items.row(environmentId, extension, key)
      : undefined;
  if (page === undefined) return void notifications.info("That row is no longer there.");
  const commands = await getService(ICommandService);
  const poster = rowPoster(page);
  if ("thread" in poster) {
    await commands.executeCommand("pult-shell.selectThread", page.environmentId, poster.thread);
    const selection = selectionTarget();
    // A switch cancelled over a modified file leaves the selection as it was.
    if (
      selection === undefined ||
      !("threadId" in selection) ||
      selection.threadId !== poster.thread
    )
      return;
  } else {
    if (starById(poster.star) === undefined)
      return void notifications.info(
        "The Star that posted it is not on any environment Pult holds.",
      );
    await commands.executeCommand("pult-shell.selectStar", poster.star);
    if (selectedStar() !== poster.star) return;
  }
  const file = page.row.open.file;
  if (file === undefined) {
    if (page.row.open.reply !== undefined) todo("a row's reply opened with no file to sit under");
    return;
  }
  const resource = pultResource(page.environmentId, toUriPath(file));
  replying = {
    environmentId: page.environmentId,
    extension: page.extension,
    key: page.row.key,
    resource: resource.toString(),
    opened: ++opened,
  };
  onDidChangeReplying.fire();
  await (await getService(IEditorService)).openEditor({ resource });
  if (page.row.open.reply !== undefined) await commands.executeCommand("pult-shell.showComposer");
}

/** `pult-shell.openExtensionRow`, not in the palette. Registered before the workbench starts. */
export function registerExtensionRowCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openExtensionRow",
          title: { value: "Open Extension Row", original: "Open Extension Row" },
          f1: false,
        });
      }

      run(_: unknown, environmentId?: unknown, extension?: unknown, key?: unknown): Promise<void> {
        return openRow(environmentId, extension, key);
      }
    },
  );
}
