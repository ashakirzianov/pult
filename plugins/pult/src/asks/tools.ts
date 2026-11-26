// `pult_ask`, `pult_ask_settle` and `pult_ask_list` (`asks.ts`): the poster is read from the call, a
// Star's conversation posting as the Star and its channel, any other thread as itself. Registered on
// the extension contract (`tools.register`), so an outside MCP client is refused and not offered them;
// work a fenced link started may post, settle and list its own asks only.
import {
  Effect,
  type ExtensionHost,
  Schema,
  type ToolCaller,
  Tool,
  Toolkit,
} from "../extension.ts";
import { CHANNEL_PATTERN } from "../stars/channels.ts";
import { Ask, AskRefused, type Asks, type AskStars, AskThreadId, type Poster } from "./asks.ts";
import type { AskRows } from "./rows.ts";

const AskTool = Tool.make("pult_ask", {
  description:
    "Ask the user something in Pult: the ask waits in the user's Inbox until they answer or settle it. Its context is a file: name the one that already says what you need with `file`, in this thread's worktree or project folder (absolute, or relative to it), or pass `text`, Markdown Pult keeps for you; exactly one of them for a new ask. `title` defaults to the context's first line. The user's reply comes as a message to this conversation (for a Star, to the channel that asked) opening `[In reply to your ask <id> \"<title>\"…]`; if the user settles the ask, a message opening `[From Pult, about your ask <id> \"<title>\"…]` tells you so; a settle that crossed your asking again is refused, though its message may still reach you, and the ask stays open as you asked it again. With the `id` of one of your own asks you ask again: it returns to the Inbox, a settled one reopens, and a `title` or `text` you pass replaces the old, though an ask posted with `file` takes no `text`: change the file. The same `file` posted again without an `id` is your open ask of that file, asked again. Settle an ask with `pult_ask_settle` once it is answered or no longer needed; a settled ask is removed 7 days after its settle, and its `id` is then unknown.",
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
    replies: Schema.optional(
      Schema.Array(Schema.String).annotate({
        description:
          "1 to 4 reply options, each a distinct single line of at most 200 characters, offered beside the reply input. A click fills the input, the user may edit it before sending, and the reply arrives as any reply does: nothing tells you which option was clicked. Asking again replaces them; left out, the ask has none.",
      }),
    ),
  }),
  success: Schema.Struct({ id: Schema.String, status: Schema.Literals(["posted"]) }),
  failure: AskRefused,
  failureMode: "return",
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Destructive, false);

const SettleTool = Tool.make("pult_ask_settle", {
  description:
    "Settle one of your own asks in Pult (for a Star, an ask of any of its channels) once it is answered or no longer needed: it leaves the user's Inbox for Settled, and nobody is told. It is removed 7 days after its settle; until then `pult_ask` with its `id` reopens it.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, status: Schema.Literals(["settled"]) }),
  failure: AskRefused,
  failureMode: "return",
})
  .annotate(Tool.Title, "Settle an ask")
  .annotate(Tool.Destructive, false);

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
    thread: Schema.optional(AskThreadId.annotate({ description: "A thread's id." })),
    settled: Schema.optional(
      Schema.Boolean.annotate({ description: "Whether to list settled asks too." }),
    ),
  }),
  success: Schema.Struct({ asks: Schema.Array(Ask) }),
  failure: AskRefused,
  failureMode: "return",
})
  .annotate(Tool.Title, "List asks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AsksToolkit = Toolkit.make(AskTool, SettleTool, ListTool);

const refused = (message: string) => new AskRefused({ code: "invalid_request", message });

/** Registers the tools, last in the plugin's activation, once everything else is up. */
export const register = Effect.fn("PultTools.registerAsks")(function* (
  host: ExtensionHost,
  stars: AskStars,
  asks: Asks,
  rows: AskRows,
) {
  const unavailable = (error: { readonly message: string }) =>
    new AskRefused({ code: "orchestration_error", message: error.message });

  /** Who calls: its poster, a Star's conversation as the Star and its channel. */
  const posterOf = (caller: ToolCaller) =>
    stars.posterOf(caller.thread.id).pipe(
      Effect.mapError(unavailable),
      Effect.map((own): Poster => own ?? { thread: caller.thread.id }),
    );

  /** Whether a record's poster is the caller: for a Star, any of its channels. */
  const isOwn = (caller: Poster) => (poster: Poster) =>
    "star" in caller
      ? "star" in poster && poster.star === caller.star
      : "thread" in poster && poster.thread === caller.thread;

  const list = Effect.fn("PultTools.listAsks")(function* (
    input: typeof ListTool.parametersSchema.Type,
    caller: ToolCaller,
  ) {
    const poster = yield* posterOf(caller);
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
    if (caller.fenced && !own)
      return yield* new AskRefused({
        code: "capability_denied",
        message:
          "This work was started through a linked environment, so it may list only its own asks. A link paired with full access is not limited this way.",
      });
    const found = yield* asks
      .list({ star, channel: input.channel, thread, settled: input.settled === true })
      .pipe(Effect.mapError(unavailable));
    return { asks: found };
  });

  yield* host.tools.register(AsksToolkit, {
    pult_ask: {
      access: "acts-as-caller",
      handle: (input, caller) =>
        Effect.flatMap(posterOf(caller), (poster) =>
          asks.post(poster, caller.folder ?? undefined, input),
        ).pipe(Effect.tap(() => rows.publish)),
    },
    pult_ask_settle: {
      access: "acts-as-caller",
      handle: (input, caller) =>
        Effect.flatMap(posterOf(caller), (poster) => asks.settleOwn(input.id, isOwn(poster))).pipe(
          Effect.tap(() => rows.publish),
        ),
    },
    pult_ask_list: { access: "reads-as-caller", handle: list },
  });
});
