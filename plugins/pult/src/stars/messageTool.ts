// `pult_star_message` (xaxis `pult/issues/message-star.md`, `pult/issues/star-channels.md`): a thread
// messages a Star by its id, into the call's channel, else its tag's beside the Star's child tag, else
// `work`, nothing refused. Declared through the server's `McpToolAccess` and `toolkitRegistration`,
// as the built-in toolkits are, so upstream's access checks run unchanged.
import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";

import {
  Effect,
  McpInvocationContext,
  McpLinkOrigin,
  McpThreadAccess,
  McpToolAccess,
  ProjectService,
  Schema,
  SecureRandom,
  ThreadManagementService,
  Tool,
  Toolkit,
  toolkitRegistration,
} from "../host.ts";
import { CHANNEL_PATTERN, childTag, taggedChannel, WORK_CHANNEL } from "./channels.ts";
import type { Deliver } from "./deliver.ts";
import { starName } from "./record.ts";
import type { Star, Stars } from "./stars.ts";

const StarMessageTool = Tool.make("pult_star_message", {
  description:
    "Message a Star, the user's personal agent in Pult, by its `id`. A Star holds one conversation per channel, and the message lands in the `channel` you name; else, from a thread the Star launched (tagged `pult:child:star:<id>`), in the channel its `pult:channel:<slug>` tag names; else in `work`. It is queued into that channel's conversation if one is open, or wakes a fresh one, and the Star answers in its own time: the call does not wait for the answer. The Star sees which thread sent it, and from which of its channels where a Star sent it. The Star's modes cannot be broader than yours. A Star may message its own `id` with a `channel`, to hand something to another of its channels. After an error or lost reply, retry with the same `clientRequestId`; a retry of a send that went through answers `replayed`, and may not name the thread (`threadId` null).",
  parameters: Schema.Struct({
    star: Schema.String.annotate({ description: "The Star's id, as its record names it." }),
    message: Schema.String.check(Schema.isMaxLength(120000)),
    channel: Schema.optional(
      Schema.String.check(Schema.isPattern(CHANNEL_PATTERN)).annotate({
        description:
          "The Star's channel to land in, a slug: lowercase letters, digits and hyphens, starting with a letter or a digit, up to 51 characters. Naming one makes it; `user` is the Star's conversation with the user, `work` the default.",
      }),
    ),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  }),
  success: Schema.Struct({
    star: Schema.Struct({ id: Schema.String, name: Schema.String }),
    outcome: Schema.Literals(["started", "queued", "launched", "replayed"]),
    threadId: Schema.NullOr(ThreadId),
    link: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Message a Star")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const PultToolkit = Toolkit.make(StarMessageTool);

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const named = (star: Star) => `"${starName(star)}" (${star.id})`;

/** The tool's registration, to build in the plugin's activation once everything else is up. */
export const make = Effect.fn("PultTools.make")(function* (stars: Stars, deliver: Deliver) {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const newKey = (yield* SecureRandom.SecureRandom).uuidV4();
  const unavailable = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

  /** `thread <id> "<title>" in project "<title>"`. */
  const threadLine = Effect.fn("PultTools.threadLine")(function* (
    threadId: ThreadId,
    shell: OrchestrationV2ThreadShell | null,
  ) {
    if (shell === null) return `thread ${threadId}`;
    const project = yield* projects.getShell(shell.projectId);
    return project._tag === "Some"
      ? `thread ${threadId} "${shell.title}" in project "${project.value.title}"`
      : `thread ${threadId} "${shell.title}"`;
  }, Effect.mapError(unavailable));

  const messageStar = Effect.fn("PultTools.messageStar")(function* (
    input: typeof StarMessageTool.parametersSchema.Type,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Messaging a Star");
    const threadId = caller.thread.threadId;
    // Fenced work may change only its own link's threads, and a Star's conversation is never one:
    // a thread a fenced link starts in a Star's project is no conversation of the Star (`Stars`).
    yield* McpLinkOrigin.assertNotLinked(yield* McpThreadAccess.loadCaller(), "message a Star");
    const star = yield* stars.get(input.star).pipe(Effect.mapError(unavailable));
    if (star === undefined) {
      const known = yield* stars.list.pipe(Effect.mapError(unavailable));
      return yield* refused(
        known.length === 0
          ? `No Star has the id "${input.star}": this server has no Star.`
          : `No Star has the id "${input.star}" on this server. Its Stars: ${known.map(named).join(", ")}.`,
      );
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    const own = yield* stars.ofThread(threadId).pipe(Effect.mapError(unavailable));
    // A channel tag counts beside this Star's child tag alone, so another Star's builder lands in work.
    const tagged = shell?.tags?.includes(childTag(star.id)) ? taggedChannel(shell.tags) : undefined;
    const channel = input.channel ?? tagged ?? WORK_CHANNEL;
    // Another Star's conversation is named as the Star and its channel: an answer sent to that thread would revive it cold.
    const from =
      own === undefined
        ? yield* threadLine(threadId, shell)
        : own.star.id === star.id
          ? `your channel ${own.channel}`
          : `Star ${named(own.star)}, its channel ${own.channel}`;
    const key =
      input.clientRequestId === undefined
        ? yield* newKey
        : `${scope.requestNamespace}:${input.clientRequestId}`;
    const delivered = yield* deliver({
      star,
      text: input.message,
      from,
      to: channel,
      key,
      sender: { thread: threadId },
    });
    return {
      star: { id: star.id, name: starName(star) },
      outcome: delivered.outcome,
      threadId: delivered.threadId,
      link:
        delivered.threadId === null
          ? null
          : McpInvocationContext.threadLinkFor(scope, delivered.threadId),
    };
  });

  return toolkitRegistration(
    PultToolkit,
    McpToolAccess.toLayer(PultToolkit, {
      // The Star's thread is resolved inside, under its lock, so the declaration names no thread:
      // it loads and checks the caller and provides its limits, which `deliver` holds the
      // resolved target to with the wrapper's own helper. The link fence is the handler's own.
      pult_star_message: McpToolAccess.writesThreads(() => [], messageStar),
    }),
  );
});
