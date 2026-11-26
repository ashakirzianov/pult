// The asks (Beta's `designs/ask-model.md`): one JSON record per ask in the extension's data folder, its
// context a file the poster names or Markdown Pult keeps in the asks folder, a hidden project; a settled
// ask goes 7 days after its settle, a plain thread's follow its thread, read when listing. On the
// extension contract (`../extension.ts`), the Stars reached through one port (`AskStars`).
import {
  DateTime,
  Effect,
  type ExtensionHost,
  FileSystem,
  Path,
  Schema,
  Semaphore,
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
  `The user settled this ask ${replied ? "after replying to it" : "without replying to it"}. \`pult_ask\` with its id reopens it for 7 days.`;

/** The first non-empty line with its leading `#`s dropped, its whitespace one space; `fallback` where that leaves nothing. */
function contextTitle(text: string, fallback: string): string {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== "");
  return oneLine(line?.trim().replace(/^#+/, "") ?? "") || fallback;
}

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
}

export interface ListFilter {
  readonly star?: string | undefined;
  readonly channel?: Channel | undefined;
  readonly thread?: string | undefined;
  readonly settled: boolean;
}

export type Action =
  | { readonly kind: "replied" }
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
  /** `pult_ask_settle`: the poster's own, silently; `mine` says whether a record's poster is the caller. */
  readonly settleOwn: (
    id: string,
    mine: (poster: Poster) => boolean,
  ) => Effect.Effect<{ readonly id: string; readonly status: "settled" }, AskRefused>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<Ask>, AsksError>;
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

  /** Pult's Markdown and the record, gone: the record last, so a removal that fails is retried. */
  const remove = Effect.fn("Asks.remove")(
    function* (record: AskRecord) {
      if (record.kept) yield* fs.remove(record.file, { force: true });
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
          if (input.text !== undefined)
            yield* fs
              .writeFileString(record.file, input.text)
              .pipe(Effect.mapError(failed("write")), Effect.mapError(unavailable));
          yield* write({
            ...record,
            title:
              title ??
              (input.text === undefined ? record.title : contextTitle(input.text, record.title)),
            // A Star's ask is answered where it was asked last.
            poster,
            posted: now,
            replied: null,
            snoozedUntil: null,
            settled: null,
            replies,
          }).pipe(Effect.mapError(unavailable));
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
        }).pipe(Effect.mapError(unavailable));
        return { id, status: "posted" as const };
      }),
    );

  const settleOwn: Asks["settleOwn"] = (id, mine) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const found = (yield* load.pipe(Effect.mapError(unavailable))).find(
          (each) => each.record.id === id,
        );
        if (found === undefined) return yield* unknownAsk(id);
        if (!mine(found.record.poster))
          return yield* refused(`The ask "${id}" is not yours: you may settle only your own.`);
        if (found.record.settled === null)
          yield* write({ ...found.record, settled: iso(yield* DateTime.now) }).pipe(
            Effect.mapError(unavailable),
          );
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

  /** Tells the poster of the user's settle, once per posting: a retry after a failure tells it again, a repeat replays. */
  const tellSettled = Effect.fn("Asks.tellSettled")(function* (record: AskRecord) {
    const about = `Pult, about your ask ${record.id} "${headerTitle(record.title)}"`;
    const notice = caption("From Pult, about the ask", headerTitle(record.title), {
      row: record.id,
    });
    const text = settleText(record.replied !== null);
    const key = `ask-settled:${record.id}:${record.posted}`;
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
        yield* Effect.logWarning("An ask's Star is gone: its settle is told to no one.", {
          askId: record.id,
          starId: record.poster.star,
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

  const act: Asks["act"] = Effect.fn("Asks.act")(function* (id, action) {
    const find = loadOne(id);
    // Told before it is written, so a notice that fails fails the settle, to be tried again.
    if (action.kind === "settle") {
      const before = yield* lock.withPermits(1)(find);
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
          const next: AskRecord =
            action.kind === "replied"
              ? // A reply moves it to Working, from Snoozed too.
                { ...record, replied: now, snoozedUntil: null }
              : action.kind === "snooze"
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
    const { ask } = found;
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
    yield* act(id, { kind: "replied" });
    return { thread };
  });

  return { post, settleOwn, list, reply, act } satisfies Asks;
});
