// `pult_star_message` (xaxis `pult/issues/message-star.md`, The tool): another thread messages a
// Star by its id, always into its work conversation (`pult/issues/star-multiple-threads.md`).
// Declared as the built-in toolkits declare theirs, through the server's `McpToolAccess` and
// `toolkitRegistration`, so upstream's access checks run unchanged.
import {
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
import type { Deliver } from "./deliver.ts";
import { starName } from "./record.ts";
import type { Star, Stars } from "./stars.ts";

const StarMessageTool = Tool.make("pult_star_message", {
  description:
    "Message a Star, the user's personal agent in Pult, by its `id`. It goes to the Star's work conversation, never to its conversation with the user: queued into the work conversation if one is open, or waking a fresh one, and the Star answers in its own time: the call does not wait for the answer. The Star sees which thread sent it. The Star's modes cannot be broader than yours. A Star's conversation with the user may message its own `id`, to hand something to its work conversation; its work conversation may not. After an error or lost reply, retry with the same `clientRequestId`; a retry of a send that went through answers `replayed`, and may not name the thread (`threadId` null).",
  parameters: Schema.Struct({
    star: Schema.String.annotate({ description: "The Star's id, as its record names it." }),
    message: Schema.String.check(Schema.isMaxLength(120000)),
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
  const threadLine = Effect.fn("PultTools.threadLine")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
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
    const own = yield* stars.ofThread(threadId).pipe(Effect.mapError(unavailable));
    const ownStar = own?.star.id === star.id;
    // Nothing a thread sends reaches the conversation with the user, so work never messages its own Star.
    if (ownStar && own?.kind === "work")
      return yield* refused(
        `This thread is Star ${named(star)}'s own work conversation; a message to itself later is a schedule.`,
      );
    // Another Star's conversation is named as the Star: an answer sent to that thread would revive it cold.
    const from =
      own === undefined
        ? yield* threadLine(threadId)
        : ownStar
          ? "your conversation with the user"
          : `Star ${named(own.star)}`;
    const key =
      input.clientRequestId === undefined
        ? yield* newKey
        : `${scope.requestNamespace}:${input.clientRequestId}`;
    const delivered = yield* deliver({
      star,
      text: input.message,
      from,
      to: "work",
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
