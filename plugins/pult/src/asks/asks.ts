// The asks: one JSON record per ask in the extension's data folder, its context a file the poster names
// or Markdown Pult keeps in the asks folder, a hidden project, and its comments written into its page
// there; a settled ask goes 7 days after its settle, a plain thread's follow its thread, read when
// listing. On the extension contract (`../extension.ts`), the Stars reached through one port (`AskStars`).
import {
  DateTime,
  Effect,
  type ExtensionHost,
  FileSystem,
  Path,
  Schema,
  Semaphore,
  Stream,
  type Composed,
  type Thread,
  type ThreadMessage,
} from "../extension.ts";
import { type Channel, CHANNEL_PATTERN } from "../stars/channels.ts";
import { caption, headerTitle } from "../stars/deliver.ts";

/** How long a settled ask is kept after its settle. */
const EXPIRY_MS = 7 * 24 * 60 * 60_000;

/** A thread's id as `pult_ask_list` advertises it, `ThreadId`'s JSON schema and trim, kept here since an extension bundles no `@t3tools/contracts`. */
export const AskThreadId = Schema.Trim.check(Schema.isNonEmpty());

/** A refusal, on the wire as upstream's `OrchestratorMcpFailure`: agents read its `code` and `message`. */
export class AskRefused extends Schema.TaggedError<AskRefused>()("OrchestratorMcpFailure", {
  code: Schema.Literals(["invalid_request", "orchestration_error", "capability_denied"]),
  message: Schema.String,
}) {}

/** What asks need of the Stars, two features of one plugin: the port Stars implement (`stars/forAsks.ts`). */
export interface AskStars {
  /** The asks folder, Pult's Markdown for the asks posted as `text`, whose project Stars hide. */
  readonly asksFolder: string;
  /** The Star and channel whose conversation the thread is; undefined for any other thread. */
  readonly posterOf: (
    threadId: string,
  ) => Effect.Effect<
    { readonly star: string; readonly channel: Channel } | undefined,
    { readonly message: string }
  >;
  /** A message of Pult's into the channel, once per `key`; "gone" for a Star that is no more. */
  readonly tell: (tell: {
    readonly star: string;
    readonly channel: Channel;
    readonly text: string;
    readonly from: NonNullable<ThreadMessage["header"]>;
    readonly key: string;
  }) => Effect.Effect<"told" | "gone", { readonly message: string }>;
  /** The user's reply into the channel, `deliver`'s user sender: the conversation it landed in. */
  readonly reply: (reply: {
    readonly star: string;
    readonly channel: Channel;
    readonly composed: Composed;
    readonly from: NonNullable<ThreadMessage["header"]>;
    readonly key: string;
  }) => Effect.Effect<string, { readonly message: string }>;
  /** Where a reply to the Star's ask goes, for its composer: the Star's project, the model the channel would take, and what the page tells; undefined for a Star that is no more. */
  readonly replyTarget: (
    star: string,
    channel: Channel,
  ) => Effect.Effect<
    | { readonly project: string; readonly model: Composed["model"]; readonly note: string }
    | undefined,
    { readonly message: string }
  >;
}

/** Who posted an ask: a Star's conversation, as the Star and its channel, or any other thread. */
const Poster = Schema.Union([
  Schema.Struct({
    star: Schema.String,
    channel: Schema.String.check(Schema.isPattern(CHANNEL_PATTERN)),
  }),
  Schema.Struct({ thread: AskThreadId }),
]);
export type Poster = typeof Poster.Type;

/** A passage the user's comment cites, written on the page where its marker stands in the comment's text. */
const AskCitation = Schema.Struct({
  /** The marker as the composer wrote it in the text. */
  marker: Schema.String,
  /** A file's lines, its path from the root where Pult can tell it, or a thread's message. */
  source: Schema.Union([
    Schema.Struct({
      file: Schema.String,
      lines: Schema.String,
      language: Schema.optional(Schema.String),
    }),
    Schema.Struct({ thread: Schema.String, message: Schema.String }),
  ]),
  quote: Schema.String,
  /** The user's comment on the passage. */
  comment: Schema.optional(Schema.String),
});
type AskCitation = typeof AskCitation.Type;

/** One comment of the exchange: the user's reply, or the poster's answer, a settle's closing one. */
const AskComment = Schema.Struct({
  by: Schema.Literals(["user", "poster"]),
  at: Schema.String,
  text: Schema.String,
  closing: Schema.optional(Schema.Literal(true)),
  /** The user's citations; a comment from before them, or with none, has none. */
  citations: Schema.optional(Schema.Array(AskCitation)),
});
type AskComment = typeof AskComment.Type;

/** An ask as its file holds it. `kept` is Pult's Markdown, deleted with the ask; a named file never is. */
const AskRecord = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  poster: Poster,
  file: Schema.String,
  kept: Schema.Boolean,
  posted: Schema.String,
  replied: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  settled: Schema.NullOr(Schema.String),
  /** The reply options its poster suggests; a record from before them has none. */
  replies: Schema.optional(Schema.Array(Schema.String)),
  /** The key of the latest reply to this posting, which its message's id carries: the poster is told if the run it started left the ask replied. A record from before it has none. */
  replyKey: Schema.optional(Schema.NullOr(Schema.String)),
  /** The exchange, in order; a record from before them has none. */
  comments: Schema.optional(Schema.Array(AskComment)),
  /** The Markdown of an ask posted with `text`; a record from before it reads its kept file, while that holds only the text. */
  text: Schema.optional(Schema.String),
});
type AskRecord = typeof AskRecord.Type;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(AskRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(AskRecord));

const ASK_STATUSES = ["posted", "replied", "snoozed", "settled"] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

/** An ask as the tools and the routes serve it: `settled` is its own settle, else its thread's. */
export const Ask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(ASK_STATUSES),
  file: Schema.String,
  /** The file the user sees: the ask's page once it has one, else its `file`. */
  page: Schema.String,
  poster: Poster,
  posted: Schema.String,
  replied: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  settled: Schema.NullOr(Schema.String),
  replies: Schema.Array(Schema.String),
});
export type Ask = typeof Ask.Type;

/**
 * The header a reply carries (`messageHeader.ts`), written here and served with the ask, which the
 * page's composer attaches: its line a Star's names its posting channel, as the settle notice does
 * (Anton's ruling, 2026-11-21).
 */
const replyHeader = (ask: Pick<Ask, "id" | "title" | "poster">) => ({
  extension: "pult",
  line: `[In reply to your ask ${ask.id} "${headerTitle(ask.title)}"${"star" in ask.poster ? `, to your channel ${ask.poster.channel}` : ""}]`,
  caption: {
    reply: true,
    lead: "Reply to the ask",
    name: headerTitle(ask.title),
    open: { row: ask.id },
    note: null,
  },
});

/** What the user's settle tells the poster, below the delivery's line (`settleNotice`). */
const settleText = (replied: boolean) =>
  `The user settled this ask ${replied ? "after commenting on it" : "without commenting on it"}. \`pult_ask\` with its id reopens it for 7 days.`;

/** What the poster is told when the turn that received the user's comment left the ask replied (`pult/decisions`, `ask-reply-unanswered`). */
const UNANSWERED_TEXT =
  "The turn that received the user's comment on this ask ended with the ask neither answered nor settled, so the user still sees it as being worked on. If the comment needs an answer, call `pult_ask` with its `id` and your answer as `comment`; if nothing is left to ask, settle it with `pult_ask_settle`. Pult tells you once per comment.";

/** A comment's heading on the page, its time to the minute. */
const commentHeading = (comment: AskComment) =>
  `## ${comment.by === "user" ? "User" : comment.closing ? "Agent, settling" : "Agent"}, ${comment.at.slice(0, 10)} ${comment.at.slice(11, 16)} UTC`;

/** Each line of `text` quoted. */
const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** Languages whose lines read as Markdown in a quote; any other's are quoted as a fenced block. */
const PROSE = new Set(["md", "markdown", "text"]);

/**
 * A citation as the thread view draws one, as far as Markdown goes: its source (a file's path, a
 * chip when it is from the root, and its lines; or the thread's message) and the passage quoted,
 * then the comment made on it.
 */
function citationText(citation: AskCitation): string {
  const { source } = citation;
  const header =
    "file" in source ? `\`${source.file}\` · ${source.lines}` : "A message in the thread";
  const language = "file" in source ? (source.language ?? "diff") : "md";
  const fence = "`".repeat(
    Math.max(3, ...Array.from(citation.quote.matchAll(/`+/g), (run) => run[0].length + 1)),
  );
  const quote = PROSE.has(language)
    ? citation.quote.trimEnd()
    : `${fence}${language}\n${citation.quote.trimEnd()}\n${fence}`;
  const comment = citation.comment?.trim() ?? "";
  return `${quoted(`${header}\n\n${quote}`)}${comment === "" ? "" : `\n\n${comment}`}`;
}

/** A comment's text with each citation written where its marker stands, as blocks of their own. */
const commentText = (comment: AskComment) =>
  (comment.citations ?? [])
    .reduce(
      (text, citation) =>
        text.replace(
          new RegExp(`\\n*${citation.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`, "g"),
          () => `\n\n${citationText(citation)}\n\n`,
        ),
      comment.text,
    )
    .trim();

/** The page: the ask's text or its file's chip, then each comment under its heading; only the text while it has none. */
function pageText(head: string, comments: ReadonlyArray<AskComment>): string {
  if (comments.length === 0) return head;
  return `${[head.trimEnd(), "---", ...comments.map((each) => `${commentHeading(each)}\n\n${commentText(each)}`)].join("\n\n")}\n`;
}

/** A file or diff comment of the composer's, which its context carries. */
type FileComment = Extract<
  NonNullable<Composed["context"]>["records"][number],
  { readonly kind: "review-comment" }
>;

/** A file comment's marker in the composed text, or an assistant quote's link, which carries its quote. */
const CITATION_MARKER =
  /\[[^[\]\n]*\]\((?:t3-context:\/\/v1\/review-comment\/([A-Za-z0-9_-]+)|(t3-citation:\/\/v1\/[^\s)]+))\)/g;

/**
 * The citations of a reply, each by its marker in the text: a file comment's lines from its record
 * in the composed context, its path as `fromRoot` reads it; an assistant quote's passage from its
 * link. A marker with neither stays in the text as written.
 */
function citationsOf(
  composed: Composed,
  fromRoot: (file: string) => string,
): ReadonlyArray<AskCitation> {
  const records = composed.context?.records ?? [];
  return Array.from(composed.text.matchAll(CITATION_MARKER)).flatMap(
    ([marker, contextId, link]): ReadonlyArray<AskCitation> => {
      if (link !== undefined) {
        const url = new URL(link);
        const [, , thread = "", message = ""] = url.pathname.split("/").map(decodeURIComponent);
        const quote = url.searchParams.get("text");
        const comment = url.searchParams.get("comment");
        return quote === null
          ? []
          : [
              {
                marker,
                source: { thread, message },
                quote,
                ...(comment === null ? {} : { comment }),
              },
            ];
      }
      const record = records.find(
        (each): each is FileComment =>
          each.kind === "review-comment" && "filePath" in each && each.contextId === contextId,
      );
      if (record === undefined) return [];
      return [
        {
          marker,
          source: {
            file: fromRoot(record.filePath),
            lines: record.rangeLabel,
            ...(record.fenceLanguage === undefined ? {} : { language: record.fenceLanguage }),
          },
          quote: record.diff,
          ...(record.text.trim() === "" ? {} : { comment: record.text }),
        },
      ];
    },
  );
}

/** The first non-empty line with its leading `#`s dropped, its whitespace one space; `fallback` where that leaves nothing. */
function contextTitle(text: string, fallback: string): string {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== "");
  return oneLine(line?.trim().replace(/^#+/, "") ?? "") || fallback;
}

/** A YAML frontmatter block opening a file, which a page would render as a rule and a heading; one never closed is kept. */
const LEADING_FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

const refused = (message: string) => new AskRefused({ code: "invalid_request", message });

const MAX_REPLIES = 4;
const MAX_REPLY_LENGTH = 200;

/** A post's reply options, trimmed, or what rule they break, in the words of the refusal. */
function checkReplies(replies: ReadonlyArray<string>): ReadonlyArray<string> | { broken: string } {
  if (replies.length < 1 || replies.length > MAX_REPLIES)
    return {
      broken: `\`replies\` holds ${replies.length} options: pass 1 to ${MAX_REPLIES}, or leave it out.`,
    };
  const trimmed = replies.map((reply) => reply.trim());
  for (const [index, reply] of replies.entries()) {
    const option = `\`replies\` option ${index + 1}`;
    const text = trimmed[index] ?? "";
    if (text === "") return { broken: `${option} is empty.` };
    if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(reply))
      return { broken: `${option} has a line break: each is a single line.` };
    const length = [...reply].length;
    if (length > MAX_REPLY_LENGTH)
      return { broken: `${option} is ${length} characters: at most ${MAX_REPLY_LENGTH}.` };
    const first = trimmed.indexOf(text);
    if (first < index) return { broken: `${option} repeats option ${first + 1}.` };
  }
  return trimmed;
}

const MAX_COMMENT_LENGTH = 120000;

/** A comment as passed, or what rule it breaks, in the words of the refusal. */
function checkComment(comment: string): string | { broken: string } {
  if (comment.trim() === "")
    return { broken: "`comment` is empty: write your answer, or leave it out." };
  if (comment.length > MAX_COMMENT_LENGTH)
    return {
      broken: `\`comment\` is ${comment.length} characters: at most ${MAX_COMMENT_LENGTH}; put the long part in the ask's file or \`text\`.`,
    };
  return comment;
}

const unknownAsk = (id: string) =>
  refused(
    `No ask has the id "${id}" on this server: it was never posted here, or it expired 7 days after its settle.`,
  );

export class AsksError extends Schema.TaggedError<AsksError>()("AsksError", {
  operation: Schema.Literals(["read", "write", "tell", "reply"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.operation === "tell"
      ? "Pult could not tell the poster of the settle, so the ask is not settled."
      : this.operation === "reply"
        ? `Pult could not send the reply: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
        : `Pult could not ${this.operation} the asks.`;
  }
}

/** What a post names: an ask again by its `id`, else a new one of exactly one of `file` and `text`. */
export interface PostInput {
  readonly title?: string | undefined;
  readonly file?: string | undefined;
  readonly text?: string | undefined;
  readonly id?: string | undefined;
  readonly replies?: ReadonlyArray<string> | undefined;
  /** The poster's comment on the ask of `id`. */
  readonly comment?: string | undefined;
}

export interface ListFilter {
  readonly star?: string | undefined;
  readonly channel?: Channel | undefined;
  readonly thread?: string | undefined;
  readonly settled: boolean;
}

export type Action =
  | {
      readonly kind: "replied";
      readonly posted: string;
      readonly key: string;
      readonly text: string;
      readonly citations: ReadonlyArray<AskCitation>;
    }
  | { readonly kind: "snooze"; readonly until: string | null }
  | { readonly kind: "settle" }
  | { readonly kind: "unsettle" };

export interface Asks {
  /** `pult_ask`: posts as `poster`, a `file` inside `root`, the caller's worktree or project folder, which a relative one resolves against. */
  readonly post: (
    poster: Poster,
    root: string | undefined,
    input: PostInput,
  ) => Effect.Effect<{ readonly id: string; readonly status: "posted" }, AskRefused>;
  /** `pult_ask_settle`: the poster's own, silently, with its closing `comment`; `mine` says whether a record's poster is the caller. */
  readonly settleOwn: (
    id: string,
    mine: (poster: Poster) => boolean,
    comment: string | undefined,
  ) => Effect.Effect<{ readonly id: string; readonly status: "settled" }, AskRefused>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<Ask>, AsksError>;
  /** The ask of `id` as `list` serves it; undefined for an id of no ask, or of one gone. */
  readonly get: (id: string) => Effect.Effect<Ask | undefined, AsksError>;
  /** The page's actions; undefined for an unknown ask, a string for one refused. The user's settle tells the poster. */
  /**
   * The user's reply from the composer its row's reply opens, under the ask's header, the ask then
   * replied; the thread it landed in, undefined for an unknown ask.
   */
  readonly reply: (
    id: string,
    composed: Composed,
  ) => Effect.Effect<{ readonly thread: string } | undefined, AsksError>;
  readonly act: (
    id: string,
    action: Action,
  ) => Effect.Effect<Ask | undefined | { readonly refused: string }, AsksError>;
}

const iso = (at: DateTime.DateTime) => DateTime.formatIso(at);
const millis = (at: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(at));

export const make = Effect.fn("Asks.make")(function* (host: ExtensionHost, stars: AskStars) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);

  const records = path.join(host.dataDir, "asks");
  const folder = stars.asksFolder;
  const recordFile = (id: string) => path.join(records, `${id}.json`);
  const failed = (operation: AsksError["operation"]) => (cause: unknown) =>
    new AsksError({ operation, cause });
  const unavailable = (error: { readonly message: string }) =>
    new AskRefused({ code: "orchestration_error", message: error.message });

  const write = Effect.fn("Asks.write")(
    function* (record: AskRecord) {
      yield* fs.makeDirectory(records, { recursive: true });
      yield* fs.writeFileString(recordFile(record.id), `${yield* encodeRecord(record)}\n`);
    },
    Effect.mapError(failed("write")),
  );

  /** The ask's page, Pult's to write: its kept Markdown, or for an ask of a named file the page its first comment made; undefined before that. */
  const pageOf = (record: AskRecord) =>
    record.kept
      ? record.file
      : (record.comments ?? []).length > 0
        ? path.join(folder, `${record.id}.md`)
        : undefined;

  /** Pult's Markdown or page and the record, gone: the record last, so a removal that fails is retried. */
  const remove = Effect.fn("Asks.remove")(
    function* (record: AskRecord) {
      const page = pageOf(record);
      if (page !== undefined) yield* fs.remove(page, { force: true });
      yield* fs.remove(recordFile(record.id), { force: true });
    },
    Effect.mapError(failed("write")),
  );

  /** What a thread poster's thread says of its asks: gone once archived or deleted, else settled since when. */
  const threadState = (thread: Thread | null) =>
    thread === null || thread.deletedAt !== null || thread.archivedAt !== null
      ? ("gone" as const)
      : { settled: thread.settledAt };

  /** A record as served now, or undefined where it is gone: its thread archived or deleted, or 7 days past its settle. */
  const served = Effect.fn("Asks.served")(function* (record: AskRecord, now: number) {
    const thread =
      "thread" in record.poster
        ? threadState(yield* host.threads.get(record.poster.thread))
        : { settled: null };
    if (thread === "gone") return undefined;
    // The later settle counts, so a thread settled after its ask holds it for 7 days from then.
    const settled =
      record.settled === null || thread.settled === null
        ? (record.settled ?? thread.settled)
        : record.settled > thread.settled
          ? record.settled
          : thread.settled;
    if (settled !== null && now - millis(settled) >= EXPIRY_MS) return undefined;
    const status: AskStatus =
      settled !== null
        ? "settled"
        : record.snoozedUntil !== null && millis(record.snoozedUntil) > now
          ? "snoozed"
          : record.replied !== null
            ? "replied"
            : "posted";
    return {
      id: record.id,
      title: record.title,
      status,
      file: record.file,
      page: pageOf(record) ?? record.file,
      poster: record.poster,
      posted: record.posted,
      replied: record.replied,
      snoozedUntil: record.snoozedUntil,
      settled,
      replies: record.replies ?? [],
    } satisfies Ask;
  });

  /** One record file with its ask as served, removed where gone; undefined for a file that is no record, logged and left. */
  const loadFile = Effect.fn("Asks.loadFile")(function* (file: string, now: number) {
    const record = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeRecord),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("An ask's record cannot be read.", { file, cause }), undefined),
      ),
    );
    if (record === undefined) return undefined;
    const ask = yield* served(record, now);
    if (ask === undefined) {
      yield* remove(record);
      return undefined;
    }
    return { record, ask };
  });

  /** Every record with its ask as served, the gone ones removed; a file that is no record is logged and left. Under the lock. */
  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(records))) return [];
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const names = (yield* fs.readDirectory(records)).filter((name) => name.endsWith(".json"));
    // Eight at a time, as `Stars.find` reads the records, so a load does not grow one read at a time with the asks.
    const loaded = yield* Effect.forEach(
      names.toSorted(),
      (name) => loadFile(path.join(records, name), now),
      { concurrency: 8 },
    );
    return loaded.filter((each) => each !== undefined);
  }).pipe(Effect.mapError(failed("read")));

  /** The one record of `id` with its ask as served, as `load` finds it; undefined for an id of no record. Under the lock. */
  const loadOne = Effect.fn("Asks.loadOne")(
    function* (id: string) {
      // An id names its record's file, so one that is no plain name is no record's.
      if (!/^[0-9A-Za-z-]+$/.test(id) || !(yield* fs.exists(recordFile(id)))) return undefined;
      const found = yield* loadFile(recordFile(id), DateTime.toEpochMillis(yield* DateTime.now));
      // A case-insensitive disk finds the file of another case.
      return found?.record.id === id ? found : undefined;
    },
    Effect.mapError(failed("read")),
  );

  const byPosted = (left: Ask, right: Ask) =>
    left.posted.localeCompare(right.posted) || left.id.localeCompare(right.id);

  const findProject = Effect.map(host.projects.list(), (shells) =>
    shells.find(
      (project) => project.archivedAt === null && path.resolve(project.workspaceRoot) === folder,
    ),
  );
  /** Writes Pult's Markdown for an ask, the folder registered as a project where it is not yet. */
  const keep = Effect.fn("Asks.keep")(
    function* (id: string, text: string) {
      yield* fs.makeDirectory(folder, { recursive: true });
      if ((yield* findProject) === undefined)
        yield* host.projects.create({ title: "Asks", workspaceRoot: folder });
      const file = path.join(folder, `${id}.md`);
      yield* fs.writeFileString(file, text);
      return file;
    },
    Effect.mapError(failed("write")),
  );

  /** The Markdown of an ask posted with `text`, read from its file for a record from before `text` while the file holds only that; undefined for a named file. */
  const textOf = Effect.fn("Asks.textOf")(
    function* (record: AskRecord) {
      if (!record.kept || record.text !== undefined) return record.text;
      if ((record.comments ?? []).length > 0)
        return yield* Effect.die(
          new Error(`unreachable: the ask ${record.id} has comments and no text`),
        );
      return yield* fs.readFileString(record.file);
    },
    Effect.mapError(failed("read")),
  );

  /** A named file's page opens with its chip, then the file's Markdown as it reads now; a file of another kind, or one gone, the chip alone. */
  const contextHead = Effect.fn("Asks.contextHead")(function* (file: string) {
    const chip = `Context: \`${file}\``;
    if (!/\.(md|markdown)$/i.test(file)) return chip;
    // The page is a copy for reading: a reply already delivered is recorded whatever became of the file.
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("An ask's context file cannot be read.", { file, cause }),
            "",
          ),
        ),
      );
    const body = text.replace(LEADING_FRONTMATTER, "").trim();
    return body === "" ? chip : `${chip}\n\n${body}`;
  });

  /** Writes the ask's page from its record, which holds its `text` where it is Pult's Markdown. */
  const writePage = (record: AskRecord) =>
    record.kept
      ? record.text === undefined
        ? Effect.die(new Error(`unreachable: the ask ${record.id} is written with no text`))
        : keep(record.id, pageText(record.text, record.comments ?? []))
      : (record.comments ?? []).length === 0
        ? Effect.die(new Error(`unreachable: the ask ${record.id} has no page to write`))
        : Effect.flatMap(contextHead(record.file), (head) =>
            keep(record.id, pageText(head, record.comments ?? [])),
          );

  /** The record and its page, the page first, as an ask's Markdown was written before its record. */
  const writeWithPage = (record: AskRecord) => Effect.andThen(writePage(record), write(record));

  /** A fresh id: eight hex digits, short enough for the reply's line. */
  const freshId = Effect.gen(function* () {
    for (;;) {
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- an extension's entry carries no `SecureRandom`.
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      if (!(yield* fs.exists(recordFile(id)))) return id;
    }
  }).pipe(Effect.mapError(failed("write")));

  const samePoster = (left: Poster, right: Poster) =>
    "star" in left
      ? "star" in right && left.star === right.star
      : "thread" in right && left.thread === right.thread;

  const post: Asks["post"] = (poster, root, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (input.file !== undefined && input.text !== undefined)
          return yield* refused("Pass `file` or `text`, not both.");
        if (input.text !== undefined && input.text.trim() === "")
          return yield* refused("`text` is empty: write what you ask.");
        const title = input.title === undefined ? undefined : oneLine(input.title);
        if (title === "")
          return yield* refused("`title` is empty: leave it out to take the context's first line.");
        const replies = input.replies === undefined ? undefined : checkReplies(input.replies);
        if (replies !== undefined && "broken" in replies) return yield* refused(replies.broken);
        if (input.comment !== undefined && input.id === undefined)
          return yield* refused(
            "A `comment` answers one of your asks: pass its `id`, or ask anew without a `comment`.",
          );
        const comment = input.comment === undefined ? undefined : checkComment(input.comment);
        if (comment !== undefined && typeof comment !== "string")
          return yield* refused(comment.broken);
        if (input.file !== undefined && root === undefined)
          return yield* refused(
            "This thread has no folder, so it cannot name a `file`: pass `text`.",
          );
        const file =
          input.file === undefined || root === undefined
            ? undefined
            : path.resolve(root, input.file);
        // The page opens a named file in its poster's folder.
        const inside = file === undefined || root === undefined ? "" : path.relative(root, file);
        if (file !== undefined && (inside.startsWith("..") || path.isAbsolute(inside)))
          return yield* refused(
            `\`file\` names ${file}, outside this thread's folder ${root}: name a file in it, or pass \`text\`.`,
          );
        // Pult writes the asks' pages there, which a named file could be.
        const inAsks = file === undefined ? ".." : path.relative(folder, file);
        if (file !== undefined && inAsks.split(path.sep)[0] !== ".." && !path.isAbsolute(inAsks))
          return yield* refused(
            `\`file\` names ${file}, in Pult's asks folder ${folder}, where Pult writes the asks' pages: name a file of your own, or pass \`text\`.`,
          );
        const fileText =
          file === undefined
            ? undefined
            : yield* fs
                .readFileString(file)
                .pipe(
                  Effect.mapError(() =>
                    refused(
                      `\`file\` names ${file}, which cannot be read as a text file on this server.`,
                    ),
                  ),
                );
        const all = yield* load.pipe(Effect.mapError(unavailable));
        const now = iso(yield* DateTime.now);
        // The same file posted again by its poster is its open ask, asked again.
        const again =
          input.id === undefined
            ? file === undefined
              ? undefined
              : all.find(
                  (each) =>
                    !each.record.kept &&
                    each.record.file === file &&
                    each.ask.status !== "settled" &&
                    samePoster(each.record.poster, poster),
                )
            : all.find((each) => each.record.id === input.id);
        if (
          input.id !== undefined &&
          (again === undefined || !samePoster(again.record.poster, poster))
        )
          return yield* again === undefined
            ? unknownAsk(input.id)
            : refused(`The ask "${input.id}" is not yours: you may ask again only your own.`);
        if (again !== undefined) {
          const { record } = again;
          if (file !== undefined && (record.kept || record.file !== file))
            return yield* refused(
              `The ask "${record.id}" has ${record.kept ? "Pult's Markdown" : `the file ${record.file}`} as its context, not ${file}.`,
            );
          if (input.text !== undefined && !record.kept)
            return yield* refused(
              `The ask "${record.id}" has the file ${record.file} as its context: change the file, not \`text\`.`,
            );
          const comments = record.comments ?? [];
          // Asking again without answering the user is the miss comments remove.
          if (comment === undefined && comments.at(-1)?.by === "user")
            return yield* refused(
              `The user commented last on the ask "${record.id}": answer with \`pult_ask\`, its \`id\` and your answer as \`comment\`, or settle it with \`pult_ask_settle\`.`,
            );
          const next: AskRecord = {
            ...record,
            title:
              title ??
              (input.text === undefined ? record.title : contextTitle(input.text, record.title)),
            // A Star's ask is answered where it was asked last.
            poster,
            posted: now,
            replied: null,
            replyKey: null,
            snoozedUntil: null,
            settled: null,
            replies,
            // The comment's time is the posting's, so it moves to Inbox and notifies as an ask asked again.
            comments:
              comment === undefined
                ? record.comments
                : [...comments, { by: "poster", at: now, text: comment }],
            text:
              input.text ??
              (comment === undefined
                ? record.text
                : yield* textOf(record).pipe(Effect.mapError(unavailable))),
          };
          // A named file's page shows the file as it reads at each asking.
          yield* (
            input.text === undefined &&
            comment === undefined &&
            (record.kept || comments.length === 0)
              ? write(next)
              : writeWithPage(next)
          ).pipe(Effect.mapError(unavailable));
          return { id: record.id, status: "posted" as const };
        }
        const context = fileText ?? input.text;
        if (context === undefined)
          return yield* refused("A new ask passes exactly one of `file` and `text`.");
        const id = yield* freshId.pipe(Effect.mapError(unavailable));
        const contextFile = file ?? (yield* keep(id, context).pipe(Effect.mapError(unavailable)));
        yield* write({
          id,
          title: title ?? contextTitle(context, file === undefined ? "Ask" : path.basename(file)),
          poster,
          file: contextFile,
          kept: file === undefined,
          posted: now,
          replied: null,
          snoozedUntil: null,
          settled: null,
          replies,
          ...(file === undefined ? { text: context } : {}),
        }).pipe(Effect.mapError(unavailable));
        return { id, status: "posted" as const };
      }),
    );

  const settleOwn: Asks["settleOwn"] = (id, mine, input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const comment = input === undefined ? undefined : checkComment(input);
        if (comment !== undefined && typeof comment !== "string")
          return yield* refused(comment.broken);
        const found = (yield* load.pipe(Effect.mapError(unavailable))).find(
          (each) => each.record.id === id,
        );
        if (found === undefined) return yield* unknownAsk(id);
        const { record } = found;
        if (!mine(record.poster))
          return yield* refused(`The ask "${id}" is not yours: you may settle only your own.`);
        // Its own settle: one of its thread's still takes the poster's closing comment.
        if (comment !== undefined && record.settled !== null)
          return yield* refused(
            `The ask "${id}" is already settled, so it takes no closing \`comment\`: reopen it with \`pult_ask\`, its \`id\` and a \`comment\`, if the user should read more.`,
          );
        const now = iso(yield* DateTime.now);
        if (comment !== undefined)
          yield* writeWithPage({
            ...record,
            settled: now,
            comments: [
              ...(record.comments ?? []),
              { by: "poster", at: now, text: comment, closing: true },
            ],
            text: yield* textOf(record).pipe(Effect.mapError(unavailable)),
          }).pipe(Effect.mapError(unavailable));
        else if (record.settled === null)
          yield* write({ ...record, settled: now }).pipe(Effect.mapError(unavailable));
        return { id, status: "settled" as const };
      }),
    );

  const list: Asks["list"] = (filter) =>
    lock
      .withPermits(1)(load)
      .pipe(
        Effect.map((all) =>
          all
            .map((each) => each.ask)
            .filter(
              ({ poster, status }) =>
                (filter.settled || status !== "settled") &&
                (filter.thread === undefined ||
                  ("thread" in poster && poster.thread === filter.thread)) &&
                (filter.star === undefined || ("star" in poster && poster.star === filter.star)) &&
                (filter.channel === undefined ||
                  ("star" in poster && poster.channel === filter.channel)),
            )
            .toSorted(byPosted),
        ),
      );

  const get: Asks["get"] = (id) =>
    Effect.map(lock.withPermits(1)(loadOne(id)), (found) => found?.ask);

  /** Tells the poster a notice of Pult's about its ask, once per `key`: a retry after a failure tells it again, a repeat replays. */
  const tellPoster = Effect.fn("Asks.tellPoster")(function* (
    record: AskRecord,
    text: string,
    key: string,
  ) {
    const about = `Pult, about your ask ${record.id} "${headerTitle(record.title)}"`;
    const notice = caption("From Pult, about the ask", headerTitle(record.title), {
      row: record.id,
    });
    if ("star" in record.poster) {
      const told = yield* stars.tell({
        star: record.poster.star,
        channel: record.poster.channel,
        text,
        // `[From <from>, to your channel <to>]`, the notice's line.
        from: { line: about, caption: notice },
        key,
      });
      if (told === "gone")
        yield* Effect.logWarning("An ask's Star is gone: Pult's notice is told to no one.", {
          askId: record.id,
          starId: record.poster.star,
          key,
        });
      return;
    }
    if ((yield* host.threads.get(record.poster.thread)) === null) return;
    yield* host.threads.send({
      threadId: record.poster.thread,
      key,
      header: { line: `[From ${about}]`, caption: notice },
      text,
    });
  });

  /** Tells the poster of the user's settle, once per posting. */
  const tellSettled = (record: AskRecord) =>
    tellPoster(
      record,
      settleText(record.replied !== null),
      `ask-settled:${record.id}:${record.posted}`,
    );

  const act: Asks["act"] = Effect.fn("Asks.act")(function* (id, action) {
    const find = loadOne(id);
    // Told before it is written, so a notice that fails fails the settle, to be tried again.
    const before = action.kind === "settle" ? yield* lock.withPermits(1)(find) : undefined;
    if (action.kind === "settle") {
      if (before === undefined) return undefined;
      if (before.ask.status !== "settled")
        yield* tellSettled(before.record).pipe(Effect.mapError(failed("tell")));
    }
    const changed: undefined | { readonly refused: string } | { readonly record: AskRecord } =
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* find;
          if (found === undefined) return undefined;
          const { record, ask } = found;
          const now = iso(yield* DateTime.now);
          // Its thread's settle is the thread's to undo.
          if (action.kind === "unsettle" && record.settled === null && ask.settled !== null)
            return {
              refused: "The ask reads as settled because its thread is: un-settle the thread.",
            };
          if (action.kind === "replied") {
            // The comment is the user's whatever the posting; it marks only the posting it answered replied.
            const next: AskRecord = {
              ...record,
              ...(record.posted === action.posted
                ? // A reply moves it to Working, from Snoozed too.
                  { replied: now, replyKey: action.key, snoozedUntil: null }
                : {}),
              comments: [
                ...(record.comments ?? []),
                {
                  by: "user",
                  at: now,
                  text: action.text,
                  ...(action.citations.length === 0 ? {} : { citations: action.citations }),
                },
              ],
              text: yield* textOf(record),
            };
            yield* writeWithPage(next);
            return { record: next };
          }
          // Asked again while its poster was told, so the settle is of a posting gone by.
          if (action.kind === "settle" && record.posted !== before?.record.posted)
            return {
              refused:
                "The ask was asked again as you settled it, so it is not settled: settle it again if you mean the ask as asked now.",
            };
          const next: AskRecord =
            action.kind === "snooze"
              ? { ...record, snoozedUntil: action.until }
              : action.kind === "unsettle"
                ? { ...record, settled: null }
                : ask.status === "settled"
                  ? record
                  : { ...record, settled: now };
          if (next !== record) yield* write(next);
          return { record: next };
        }),
      );
    if (changed === undefined) return undefined;
    if ("refused" in changed) return { refused: changed.refused };
    const ask = yield* served(changed.record, DateTime.toEpochMillis(yield* DateTime.now)).pipe(
      Effect.mapError(failed("read")),
    );
    // Just written, and found by the load that drops what is gone.
    return ask ?? (yield* Effect.die(new Error(`The ask ${id} went as it was changed.`)));
  });

  const reply: Asks["reply"] = Effect.fn("Asks.reply")(function* (id, composed) {
    const found = yield* lock.withPermits(1)(loadOne(id));
    if (found === undefined) return undefined;
    const { ask, record } = found;
    const header = replyHeader(ask);
    const from = { line: header.line, caption: header.caption };
    // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- an extension's entry carries no `SecureRandom`.
    const key = `ask-reply:${ask.id}:${crypto.randomUUID()}`;
    const thread =
      "star" in ask.poster
        ? yield* stars
            .reply({ star: ask.poster.star, channel: ask.poster.channel, composed, from, key })
            .pipe(Effect.mapError(failed("reply")))
        : yield* host.threads
            .send({ threadId: ask.poster.thread, key, header: from, composed })
            .pipe(Effect.mapError(failed("reply")), Effect.as(ask.poster.thread));
    // The posting it answered: one asked again meanwhile stays in Inbox.
    yield* act(id, {
      kind: "replied",
      posted: ask.posted,
      key,
      text: composed.text,
      // A path relative to the poster's checkout, the composer's for a file of it, read as the ask's file where it names it.
      citations: citationsOf(composed, (file) =>
        !path.isAbsolute(file) && record.file.endsWith(`${path.sep}${file}`) ? record.file : file,
      ),
    });
    return { thread };
  });

  // The turn a reply started ended, the ask still replied: its poster is told, once per reply.
  // A reply's message id carries its key, `<name>:<key>` into a thread, `deliver`'s
  // `pult:star-message:<star>:<key>:<path>` into a Star's channel.
  const tellUnanswered = Effect.fn("Asks.tellUnanswered")(function* (messageId: string) {
    const found = (yield* lock.withPermits(1)(load)).find(
      ({ record, ask }) =>
        record.replyKey != null &&
        messageId.includes(`:${record.replyKey}`) &&
        ask.status === "replied",
    );
    if (found === undefined) return;
    const { record } = found;
    yield* tellPoster(record, UNANSWERED_TEXT, `ask-unanswered:${record.replyKey}`);
  });
  yield* Effect.forkScoped(
    Stream.runForEach(host.threadEvents, (event) =>
      // Only a reply's message names an ask's reply key.
      event._tag === "run-completed" && event.messageId.includes(":ask-reply:")
        ? tellUnanswered(event.messageId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Pult could not tell a poster its ask's reply went unanswered.", {
                messageId: event.messageId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ),
  );

  return { post, settleOwn, list, get, reply, act } satisfies Asks;
});
