// The one door for every message Pult sends a Star (xaxis `pult/issues/message-star.md`): under the
// Star's lock it is queued into its channel's current conversation, else the channel wakes fresh, tagged,
// at the modes of its newest conversation (else `user`'s, else the Star's newest) and the model the Star
// chose for it (`pult/issues/star-channel-model.md`), else that conversation's.
import {
  type ModelSelection,
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
import { type BrokenFile, CHANNEL_MODELS_FILE, channelModel } from "./channelModels.ts";
import { type Channel, channelTag, isChannel } from "./channels.ts";
import { starName } from "./record.ts";
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
  /** The channel it is for, a slug. */
  readonly to: Channel;
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
  const resolving = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Digest.Digest
    | ProviderRegistry.ProviderRegistry
    | ThreadManagementService.ThreadManagementService
  >();
  /** The notices of broken files sent since the server started, `<star>:<key>`; the key keeps them once across restarts. */
  const told = new Set<string>();

  /** Tells the Star's `work` once per content what is wrong with its file; a notice that fails is logged, never told. */
  const tell = Effect.fn("Stars.tellChannelModels")(function* (
    deliver: Deliver,
    star: Star,
    broken: BrokenFile,
  ) {
    const key = `channel-models:${broken.hash.slice(0, 16)}`;
    // Taken before the notice, whose own wake of `work` reads the same file.
    if (told.has(`${star.id}:${key}`)) return;
    told.add(`${star.id}:${key}`);
    yield* deliver({
      star,
      text: `\`${CHANNEL_MODELS_FILE}\` cannot be served as written on this environment: ${broken.problems.join("; ")}. A choice this environment cannot serve falls back to \`default\`, then to conversation history, so the wakes go ahead. Fix the file; Pult tells you once per content.`,
      from: `Pult, about ${CHANNEL_MODELS_FILE}`,
      key,
      // Pult's own notice, which no user is waiting on.
      to: "work",
      sender: "plugin",
    }).pipe(
      Effect.catchCauseIf(notInterrupted, (cause) =>
        Effect.logWarning("Could not tell a Star its channel models are broken.", {
          starId: star.id,
          cause,
        }),
      ),
    );
  });

  return (stars: Stars): Deliver => {
    const deliver: Deliver = Effect.fn("Stars.deliver")(function* ({
      star,
      text,
      from,
      to,
      key,
      sender,
    }: Delivery) {
      if (!isChannel(to)) return yield* Effect.die(new Error(`"${to}" is no channel's slug.`));
      yield* startup.awaitCommandReady.pipe(Effect.mapError(failed));
      const limit = sender === "plugin" ? undefined : yield* DispatchModeLimit.DispatchModeLimit;
      if (sender !== "plugin" && limit === undefined)
        return yield* Effect.die(
          new Error("A thread's delivery runs inside McpToolAccess.writesThreads."),
        );
      const withinLimit = (target: OrchestrationV2ThreadShell) =>
        limit === undefined ? Effect.void : McpThreadAccess.assertTargetWithinLimits(limit, target);

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
      const chosen = Effect.fn("Stars.chosenModel")(function* (newest: OrchestrationV2ThreadShell) {
        const model = yield* channelModel(star, to, newest.runtimeMode).pipe(
          Effect.provide(resolving),
          Effect.catchTag("PlatformError", (cause) =>
            Effect.as(
              Effect.logWarning("Could not read a Star's channel models; it wakes as before.", {
                starId: star.id,
                cause,
              }),
              null,
            ),
          ),
        );
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
            // Created tagged with its channel, `user` too, so it is never read as another's.
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
        if (current === null) return yield* wakeAt(newest, true);
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
      if (found.broken !== null) yield* tell(deliver, star, found.broken);
      return delivered;
    });
    return deliver;
  };
});
