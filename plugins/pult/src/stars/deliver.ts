// The one door for every message Pult sends a Star (xaxis `pult/decisions`, `star-delivery`): under the
// Star's lock it is queued into its channel's current conversation (the default channel where it names
// none), else the channel wakes fresh, tagged, at the modes of its newest conversation, else the Star's
// newest, and the model the Star chose for it, else that conversation's.
import {
  type ModelSelection,
  type RuntimeMode,
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

import {
  Cause,
  Digest,
  DispatchModeLimit,
  Effect,
  FileSystem,
  McpThreadAccess,
  Path,
  ProviderRegistry,
  ServerRuntimeStartup,
  ThreadLaunchService,
  ThreadManagementService,
} from "../host.ts";
import {
  type BrokenFile,
  SHARED_SETTINGS_FILE,
  settingsFile,
  wakeChannelModel,
} from "./settings.ts";
import { type Channel, channelTag, isChannel } from "./channels.ts";
import { RECORD_FILE, starName } from "./record.ts";
import type { Conversations, Star, Stars } from "./stars.ts";

/**
 * Who sends: a thread, held to upstream's rule that its target's modes be no broader than its own,
 * which it reads from the `DispatchModeLimit` `McpToolAccess.writesThreads` provides; or the plugin
 * itself, for schedules, with no ceiling.
 */
export type Sender = { readonly thread: ThreadId } | "plugin";

export interface Delivery {
  readonly star: Star;
  readonly text: string;
  /** One line naming the sender, written into the stored text as `[From <from>, to your channel <to>]`. */
  readonly from: string;
  /** The channel it is for, a slug; the Star's default channel where it names none. */
  readonly to?: Channel | undefined;
  /** One per message: a repeat delivers nothing new. */
  readonly key: string;
  readonly sender: Sender;
}

export interface Delivered {
  readonly outcome: "started" | "queued" | "launched" | "replayed";
  /** The conversation the message is in; null for a repeat of a send, whose thread is not looked up. */
  readonly threadId: ThreadId | null;
}

export type Deliver = (delivery: Delivery) => Effect.Effect<Delivered, OrchestratorMcpFailure>;

/** A notice's delivery: null where it would have woken the channel and must not. */
type Notify = (delivery: Delivery) => Effect.Effect<Delivered | null, OrchestratorMcpFailure>;

/**
 * The model a fresh conversation of `channel` the page wakes itself (a channel's sleeping draft, a
 * sync's handoff) starts at `runtimeMode`: the Star's choice, else null for the page's own; telling
 * the channel what is wrong with its file as a wake by message does.
 */
export type PageWakeModel = (
  star: Star,
  runtimeMode: RuntimeMode,
  channel: Channel,
) => Effect.Effect<ModelSelection | null>;

export interface Delivering {
  readonly deliver: Deliver;
  readonly pageWakeModel: PageWakeModel;
}

/** As the web composer seeds a launch's title before the server regenerates it. */
const titleSeed = (text: string) => {
  const characters = Array.from(text.trim().replace(/\s+/gu, " "));
  return characters.length === 0
    ? "Message"
    : characters.length <= 50
      ? characters.join("")
      : `${characters.slice(0, 50).join("")}...`;
};

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const failed = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);

const notInterrupted = <E>(cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause);

/** Resolves the server's services; the Stars come after, since making them starts their pass. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const digest = yield* Digest.Digest;
  const resolving = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Digest.Digest
    | ProviderRegistry.ProviderRegistry
    | ThreadManagementService.ThreadManagementService
  >();
  /** The notices of broken files sent since the server started, `<star>:<key>`; the key keeps them once across restarts. */
  const told = new Set<string>();

  /** Tells the channel whose wake found it once per content what is wrong with its settings files; a notice that fails, or found no conversation to queue into, is told again at a later wake. */
  const tell = Effect.fn("Stars.tellChannelSettings")(function* (
    deliver: Notify,
    star: Star,
    channel: Channel,
    broken: BrokenFile,
  ) {
    const key = `channel-settings:${broken.hash.slice(0, 16)}`;
    const id = `${star.id}:${key}`;
    if (told.has(id)) return;
    told.add(id);
    yield* deliver({
      star,
      text: `The settings of your channel \`${channel}\`, \`${settingsFile(channel)}\` over \`${SHARED_SETTINGS_FILE}\`, cannot be read or served as written on this environment: ${broken.problems.join("; ")}. A choice this environment cannot serve falls back to every channel's file, then to conversation history, and a \`rotate-on-context\` Pult cannot read counts as \`250k\`, so the wakes go ahead. Fix the files; Pult tells you once per content.`,
      from: "Pult, about your channel settings",
      key,
      to: channel,
      sender: "plugin",
    }).pipe(
      // Pult's own, under no ceiling of the sender whose wake found the file broken.
      Effect.provideService(DispatchModeLimit.DispatchModeLimit, undefined),
      Effect.tap((delivered) =>
        delivered === null ? Effect.sync(() => told.delete(id)) : Effect.void,
      ),
      Effect.onError(() => Effect.sync(() => told.delete(id))),
      Effect.catchCauseIf(notInterrupted, (cause) =>
        Effect.logWarning("Could not tell a Star its channel settings are broken.", {
          starId: star.id,
          cause,
        }),
      ),
    );
  });

  /** Tells the Star once per content that its record's `default-channel` is no slug, in its default channel, `main`; told again as `tell` is. */
  const tellMisnamed = Effect.fn("Stars.tellMisnamedDefault")(function* (
    deliver: Notify,
    star: Star,
  ) {
    const written = star.misnamedDefaultChannel;
    if (written === undefined) return;
    const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(written));
    const key = `default-channel:${hash.slice(0, 16)}`;
    const id = `${star.id}:${key}`;
    if (told.has(id)) return;
    told.add(id);
    yield* deliver({
      star,
      text: `\`default-channel\` in \`${RECORD_FILE}\` is "${written}", which is no channel's slug: lowercase letters, digits and hyphens, starting with a letter or a digit, up to 51 characters. Pult reads it as \`${star.defaultChannel}\` until it names one. Pult tells you once per content.`,
      from: `Pult, about ${RECORD_FILE}`,
      key,
      sender: "plugin",
    }).pipe(
      Effect.provideService(DispatchModeLimit.DispatchModeLimit, undefined),
      Effect.tap((delivered) =>
        delivered === null ? Effect.sync(() => told.delete(id)) : Effect.void,
      ),
      Effect.onError(() => Effect.sync(() => told.delete(id))),
      Effect.catchCauseIf(notInterrupted, (cause) =>
        Effect.logWarning("Could not tell a Star its default channel is no slug.", {
          starId: star.id,
          cause,
        }),
      ),
    );
  });

  /** The Star's choice for a fresh conversation of `to` at `runtimeMode`, a file that cannot be read none. */
  const chosenFor = (star: Star, to: Channel, runtimeMode: RuntimeMode) =>
    wakeChannelModel(star, to, runtimeMode).pipe(Effect.provide(resolving));

  return (stars: Stars): Delivering => {
    /**
     * A message, telling what its wake found wrong with the Star's files; or one of those notices,
     * which tells nothing, and with `wakes` false is sent only into an open conversation, null where none is.
     */
    const deliver: (
      delivery: Delivery,
      as: { readonly telling: boolean; readonly wakes: boolean },
    ) => Effect.Effect<Delivered | null, OrchestratorMcpFailure> = Effect.fn("Stars.deliver")(
      function* (
        { star, text, from, to: named, key, sender }: Delivery,
        { telling, wakes }: { readonly telling: boolean; readonly wakes: boolean },
      ) {
        const to = named ?? star.defaultChannel;
        if (!isChannel(to)) return yield* Effect.die(new Error(`"${to}" is no channel's slug.`));
        yield* startup.awaitCommandReady.pipe(Effect.mapError(failed));
        const limit = sender === "plugin" ? undefined : yield* DispatchModeLimit.DispatchModeLimit;
        if (sender !== "plugin" && limit === undefined)
          return yield* Effect.die(
            new Error("A thread's delivery runs inside McpToolAccess.writesThreads."),
          );
        const withinLimit = (target: OrchestrationV2ThreadShell) =>
          limit === undefined
            ? Effect.void
            : McpThreadAccess.assertTargetWithinLimits(limit, target);

        const stored = `[From ${from}, to your channel ${to}]\n\n${text}`;
        const senderField = sender === "plugin" ? {} : { senderThreadId: sender.thread };
        const creation = {
          createdBy: "agent" as const,
          creationSource: sender === "plugin" ? ("server" as const) : ("mcp" as const),
        };
        const base = `pult:star-message:${star.id}:${key}`;
        const send = {
          commandId: CommandId.make(`${base}:send`),
          messageId: MessageId.make(`${base}:send`),
        };
        const wake = {
          commandId: CommandId.make(`${base}:wake`),
          messageId: MessageId.make(`${base}:wake`),
        };

        /** What a wake found wrong with the Star's file, told once the lock is released. */
        const found: { broken: BrokenFile | null } = { broken: null };

        /** The model a fresh conversation of `to` starts at: the Star's choice, else `newest`'s; a file that cannot be read is no choice. */
        const chosen = Effect.fn("Stars.chosenModel")(function* (
          newest: OrchestrationV2ThreadShell,
        ) {
          const model = yield* chosenFor(star, to, newest.runtimeMode);
          found.broken = model?.broken ?? null;
          return model?.selection ?? newest.modelSelection;
        });

        /** A launch into `to`: fresh, at the chosen model, or the resumption of one cut short, at the model it recorded. */
        const wakeAt = Effect.fn("Stars.wake")(function* (
          newest: OrchestrationV2ThreadShell | null,
          fresh: boolean,
        ) {
          if (newest === null)
            return yield* failure(
              "thread_not_found",
              `Star "${starName(star)}" (${star.id}) has had no conversation on this server, so Pult has no model or modes to wake it at.`,
            );
          yield* withinLimit(newest);
          // A resumed launch's thread is the channel's newest, created at the model the launch chose.
          const modelSelection: ModelSelection = fresh
            ? yield* chosen(newest)
            : newest.modelSelection;
          const launched = yield* launches
            .launch({
              commandId: wake.commandId,
              projectId: star.projectId,
              title: titleSeed(text),
              generateTitle: true,
              modelSelection,
              runtimeMode: newest.runtimeMode,
              interactionMode: newest.interactionMode,
              workspaceStrategy: { type: "root" },
              // Created tagged with its channel: an untagged thread is no conversation.
              tags: [channelTag(to)],
              initialMessage: {
                messageId: wake.messageId,
                text: stored,
                attachments: [],
                ...senderField,
              },
              ...creation,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? failure("invalid_request", error.message)
                  : failed(error),
              ),
            );
          return {
            outcome: launched.resumed ? "replayed" : "launched",
            threadId: launched.threadId,
          } satisfies Delivered;
        });

        const deliverNow = Effect.fn("Stars.deliverNow")(function* ({
          current,
          newest,
        }: Conversations) {
          // Two ids, one per path, so a repeat tells a finished send from a wake cut short.
          if (yield* threads.hasReceipt(send.commandId))
            return { outcome: "replayed", threadId: null } satisfies Delivered;
          if (yield* threads.hasReceipt(wake.commandId)) return yield* wakeAt(newest, false);
          if (current === null) return wakes ? yield* wakeAt(newest, true) : null;
          yield* withinLimit(current);
          const sent = yield* threads
            .sendToThread({
              projectId: star.projectId,
              threadId: current.id,
              ...send,
              text: stored,
              attachments: [],
              mode: "queue",
              ...senderField,
              ...creation,
            })
            .pipe(Effect.mapError(failed));
          if (sent.delivery !== "started" && sent.delivery !== "queued")
            return yield* Effect.die(new Error(`A queued send was ${sent.delivery}.`));
          return { outcome: sent.delivery, threadId: current.id } satisfies Delivered;
        });

        const delivered = yield* stars
          .withConversation(star, to, deliverNow)
          .pipe(Effect.catchTag("StarsError", (error) => Effect.fail(failed(error))));
        if (telling) {
          const notify: Notify = (notice) => deliver(notice, { telling: false, wakes: true });
          if (found.broken !== null) yield* tell(notify, star, to, found.broken);
          yield* tellMisnamed(notify, star);
        }
        return delivered;
      },
    );
    const pageWakeModel: PageWakeModel = Effect.fn("Stars.pageWakeModel")(
      function* (star, runtimeMode, channel) {
        const model = yield* chosenFor(star, channel, runtimeMode);
        // The page asks before it wakes the channel (a sleeping channel's ask opened) and again once
        // its own launch is the channel's conversation, so a notice only queues into an open one, else
        // waits for a later wake; `tell` logs whatever fails but an interruption.
        const notify: Notify = (notice) => deliver(notice, { telling: false, wakes: false });
        const broken = model?.broken ?? null;
        if (broken !== null) yield* tell(notify, star, channel, broken).pipe(Effect.orDie);
        yield* tellMisnamed(notify, star).pipe(Effect.orDie);
        return model?.selection ?? null;
      },
    );
    return {
      deliver: (delivery) =>
        deliver(delivery, { telling: true, wakes: true }).pipe(
          Effect.filterOrElse(
            (delivered): delivered is Delivered => delivered !== null,
            () => Effect.die(new Error("unreachable: a delivery that wakes found no conversation")),
          ),
        ),
      pageWakeModel,
    };
  };
});
