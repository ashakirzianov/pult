// `pult_ask`, `pult_ask_settle` and `pult_ask_list` (`asks.ts`): the poster is read from the call, a
// Star's conversation posting as the Star and its channel, any other thread as itself. Declared through
// the server's `McpToolAccess`, thread-bound, so an outside MCP client is refused and not offered them;
// work a fenced link started may post, settle and list its own asks only.
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";

import {
  Effect,
  McpInvocationContext,
  McpLinkOrigin,
  McpSchema,
  McpThreadAccess,
  McpToolAccess,
  ProjectService,
  Schema,
  ThreadManagementService,
  Tool,
  Toolkit,
  toolkitRegistration,
} from "../host.ts";
import { CHANNEL_PATTERN } from "../stars/channels.ts";
import type { Stars } from "../stars/stars.ts";
import { Ask, type Asks, type Poster } from "./asks.ts";

const AskTool = Tool.make("pult_ask", {
  description:
    "Ask the user something in Pult: the ask waits in the user's Inbox until they answer or settle it. Its context is a file: name the one that already says what you need with `file`, in this thread's worktree or project folder (absolute, or relative to it), or pass `text`, Markdown Pult keeps for you; exactly one of them for a new ask. `title` defaults to the context's first line. The user's reply comes as a message to this conversation (for a Star, to the channel that asked) opening `[In reply to your ask <id> \"<title>\"…]`; if the user settles the ask, a message opening `[From Pult, about your ask <id> \"<title>\"…]` tells you so. With the `id` of one of your own asks you ask again: it returns to the Inbox, a settled one reopens, and a `title` or `text` you pass replaces the old. The same `file` posted again without an `id` is your open ask of that file, asked again. Settle an ask with `pult_ask_settle` once it is answered or no longer needed; a settled ask is removed 7 days after its settle, and its `id` is then unknown.",
  parameters: Schema.Struct({
    title: Schema.optional(
      Schema.String.annotate({ description: "One line; by default the context's first line." }),
    ),
    file: Schema.optional(
      Schema.String.annotate({
        description: "The file the ask is about, which Pult never deletes.",
      }),
    ),
    text: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description: "Markdown for Pult to keep as the ask's context, deleted with the ask.",
      }),
    ),
    id: Schema.optional(
      Schema.String.annotate({ description: "One of your own asks, to ask it again." }),
    ),
  }),
  success: Schema.Struct({ id: Schema.String, status: Schema.Literals(["posted"]) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SettleTool = Tool.make("pult_ask_settle", {
  description:
    "Settle one of your own asks in Pult (for a Star, an ask of any of its channels) once it is answered or no longer needed: it leaves the user's Inbox for Settled, and nobody is told. It is removed 7 days after its settle; until then `pult_ask` with its `id` reopens it.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, status: Schema.Literals(["settled"]) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Settle an ask")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ListTool = Tool.make("pult_ask_list", {
  description:
    "The asks posted in Pult on this server, by default your own: for a Star, every channel's. Name a Star by `star` (its id, with `channel` for one of its channels) or a thread by `thread` to list theirs. Each row has its `status`: `posted` (in the user's Inbox), `replied` (the user replied), `snoozed` (until `snoozedUntil`), or `settled` (`settled` is when, its thread's settle for a thread's ask while that thread is settled); settled asks are listed only with `settled: true`. Work started from a linked environment lists only its own.",
  parameters: Schema.Struct({
    star: Schema.optional(Schema.String.annotate({ description: "A Star's id." })),
    channel: Schema.optional(
      Schema.String.check(Schema.isPattern(CHANNEL_PATTERN)).annotate({
        description: "One of the Star's channels, a slug.",
      }),
    ),
    thread: Schema.optional(ThreadId.annotate({ description: "A thread's id." })),
    settled: Schema.optional(
      Schema.Boolean.annotate({ description: "Whether to list settled asks too." }),
    ),
  }),
  success: Schema.Struct({ asks: Schema.Array(Ask) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "List asks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AsksToolkit = Toolkit.make(AskTool, SettleTool, ListTool);

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The tools' registration, to build in the plugin's activation once everything else is up. */
export const make = Effect.fn("PultTools.makeAsks")(function* (stars: Stars, asks: Asks) {
  const projects = yield* ProjectService.ProjectService;
  const unavailable = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

  /** Who calls: its poster, the folder a relative file resolves against, and whether a fenced link started it. */
  const caller = Effect.gen(function* () {
    const loaded = yield* McpThreadAccess.loadCaller();
    const shell = loaded.caller;
    // The wrappers require a thread, and `loadCaller` refuses one that is not found.
    if (shell === undefined) return yield* Effect.die(new Error("An ask's caller has no thread."));
    const own = yield* stars.ofThread(shell.id).pipe(Effect.mapError(unavailable));
    const poster: Poster =
      own === undefined ? { thread: shell.id } : { star: own.star.id, channel: own.channel };
    const project = yield* projects.getShell(shell.projectId).pipe(Effect.mapError(unavailable));
    const root =
      shell.worktreePath ?? (project._tag === "Some" ? project.value.workspaceRoot : undefined);
    return {
      poster,
      root,
      fenced: McpLinkOrigin.fencingLinkOrigin(loaded) !== undefined,
    };
  });

  /** Whether a record's poster is the caller: for a Star, any of its channels. */
  const isOwn = (caller: Poster) => (poster: Poster) =>
    "star" in caller
      ? "star" in poster && poster.star === caller.star
      : "thread" in poster && poster.thread === caller.thread;

  const ask = Effect.fn("PultTools.ask")(function* (input: typeof AskTool.parametersSchema.Type) {
    const { poster, root } = yield* caller;
    return yield* asks.post(poster, root, input);
  });

  const settle = Effect.fn("PultTools.settleAsk")(function* (
    input: typeof SettleTool.parametersSchema.Type,
  ) {
    const { poster } = yield* caller;
    return yield* asks.settleOwn(input.id, isOwn(poster));
  });

  const list = Effect.fn("PultTools.listAsks")(function* (
    input: typeof ListTool.parametersSchema.Type,
  ) {
    const { poster, fenced } = yield* caller;
    if (input.star !== undefined && input.thread !== undefined)
      return yield* refused("Name a `star` or a `thread`, not both.");
    if (input.channel !== undefined && input.thread !== undefined)
      return yield* refused("A `channel` is a Star's: name it with `star`, not `thread`.");
    const named = input.star !== undefined || input.thread !== undefined;
    const star = input.star ?? (named || !("star" in poster) ? undefined : poster.star);
    if (input.channel !== undefined && star === undefined)
      return yield* refused("A `channel` is a Star's: name the Star with `star`.");
    const thread = input.thread ?? (named || !("thread" in poster) ? undefined : poster.thread);
    const own = "star" in poster ? star === poster.star : thread === poster.thread;
    if (fenced && !own)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "This work was started through a linked environment, so it may list only its own asks. A link paired with full access is not limited this way.",
      });
    const found = yield* asks
      .list({ star, channel: input.channel, thread, settled: input.settled === true })
      .pipe(Effect.mapError(unavailable));
    return { asks: found };
  });

  return toolkitRegistration(
    AsksToolkit,
    McpToolAccess.toLayer(AsksToolkit, {
      pult_ask: McpToolAccess.actsAsCaller(ask),
      pult_ask_settle: McpToolAccess.actsAsCaller(settle),
      pult_ask_list: McpToolAccess.readsAsCaller(list),
    }),
  );
});
