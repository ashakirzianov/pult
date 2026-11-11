// The one door for every message Pult sends a Star (xaxis `pult/issues/message-star.md`, Delivery;
// `pult/issues/star-multiple-threads.md`): under the Star's lock, once it has looked, the message is
// queued into the current conversation of the kind it is for, else that kind wakes in a fresh
// thread at the model and modes of the newest conversation of that kind, else of the other.
import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

import {
  DispatchModeLimit,
  Effect,
  McpThreadAccess,
  ServerRuntimeStartup,
  ThreadLaunchService,
  ThreadManagementService,
} from "../host.ts";
import { starName } from "./record.ts";
import {
  type ConversationKind,
  type Conversations,
  type Star,
  type Stars,
  WORK_TAG,
} from "./stars.ts";

/**
 * Who sends: a thread, held to upstream's rule that its target's modes be no broader than its own,
 * which it reads from the `DispatchModeLimit` `McpToolAccess.writesThreads` provides; or the plugin
 * itself, for schedules, with no ceiling.
 */
export type Sender = { readonly thread: ThreadId } | "plugin";

export interface Delivery {
  readonly star: Star;
  readonly text: string;
  /** One line naming the sender, written into the stored text as `[From <from>, to <the conversation>]`. */
  readonly from: string;
  /** The conversation it is for: the Star's work conversation, or its conversation with the user. */
  readonly to: ConversationKind;
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

/** How the bracket line names each conversation to the Star. */
const conversationName: Record<ConversationKind, string> = {
  work: "your work conversation",
  user: "your conversation with the user",
};

/** Resolves the server's services; the Stars come after, since making them starts their pass. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

  return (stars: Stars): Deliver =>
    Effect.fn("Stars.deliver")(function* ({ star, text, from, to, key, sender }: Delivery) {
      yield* startup.awaitCommandReady.pipe(Effect.mapError(failed));
      const limit = sender === "plugin" ? undefined : yield* DispatchModeLimit.DispatchModeLimit;
      if (sender !== "plugin" && limit === undefined)
        return yield* Effect.die(
          new Error("A thread's delivery runs inside McpToolAccess.writesThreads."),
        );
      const withinLimit = (target: OrchestrationV2ThreadShell) =>
        limit === undefined ? Effect.void : McpThreadAccess.assertTargetWithinLimits(limit, target);

      const stored = `[From ${from}, to ${conversationName[to]}]\n\n${text}`;
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

      const wakeAt = Effect.fn("Stars.wake")(function* (newest: OrchestrationV2ThreadShell | null) {
        if (newest === null)
          return yield* failure(
            "thread_not_found",
            `Star "${starName(star)}" (${star.id}) has had no conversation on this server, so Pult has no model or modes to wake it at.`,
          );
        yield* withinLimit(newest);
        const launched = yield* launches
          .launch({
            commandId: wake.commandId,
            projectId: star.projectId,
            title: titleSeed(text),
            generateTitle: true,
            modelSelection: newest.modelSelection,
            runtimeMode: newest.runtimeMode,
            interactionMode: newest.interactionMode,
            workspaceStrategy: { type: "root" },
            // The work conversation is created tagged, so it is never one untagged, the user's.
            ...(to === "work" ? { tags: [WORK_TAG] } : {}),
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
        if (yield* threads.hasReceipt(wake.commandId)) return yield* wakeAt(newest);
        if (current === null) return yield* wakeAt(newest);
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

      return yield* stars
        .withConversation(star, to, deliverNow)
        .pipe(Effect.catchTag("StarsError", (error) => Effect.fail(failed(error))));
    });
});
