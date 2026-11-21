// The asks (Beta's `designs/ask-model.md`): one JSON record per ask in `<stateDir>/plugins/pult/asks/`,
// its context a file the poster names or Markdown Pult keeps in the asks folder, a hidden project. A
// settled ask goes 7 days after its settle, and a plain thread's follow its thread, read when listing,
// with no timer. Today's `.pult/asks/` files are the Stars' own (`stars/asks.ts`).
import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  DateTime,
  DispatchModeLimit,
  Effect,
  FileSystem,
  Path,
  ProjectService,
  Schema,
  Semaphore,
  SecureRandom,
  ServerConfig,
  ThreadManagementService,
} from "../host.ts";
import { type Channel, CHANNEL_PATTERN } from "../stars/channels.ts";
import type { Deliver } from "../stars/deliver.ts";
import type { Stars } from "../stars/stars.ts";

/** How long a settled ask is kept after its settle. */
const EXPIRY_MS = 7 * 24 * 60 * 60_000;

/** The asks folder, Pult's Markdown for the asks posted as `text`: beside the Stars directory. */
export const asksFolderOf = (starsDirectory: string, path: Path.Path) =>
  path.join(path.dirname(starsDirectory), "asks");

/** Who posted an ask: a Star's conversation, as the Star and its channel, or any other thread. */
const Poster = Schema.Union([
  Schema.Struct({
    star: Schema.String,
    channel: Schema.String.check(Schema.isPattern(CHANNEL_PATTERN)),
  }),
  Schema.Struct({ thread: ThreadId }),
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
});
export type Ask = typeof Ask.Type;

/**
 * The line a reply opens with, written here and served with the ask. A Star's names its posting
 * channel, as the settle notice does (a bracket line without one reads as `user`): pending
 * Anton's ruling, so the other way is this one line.
 */
const replyPrefix = (ask: Pick<Ask, "id" | "title" | "poster">) =>
  `[In reply to your ask ${ask.id} "${ask.title}"${"star" in ask.poster ? `, to your channel ${ask.poster.channel}` : ""}]`;

/** What the user's settle tells the poster, below the delivery's line (`settleNotice`). */
const settleText = (replied: boolean) =>
  `The user settled this ask ${replied ? "after replying to it" : "without replying to it"}. \`pult_ask\` with its id reopens it for 7 days.`;

/** The first non-empty line with its leading `#`s dropped, its whitespace one space; `fallback` where that leaves nothing. */
function contextTitle(text: string, fallback: string): string {
  const line = text.split(/\r?\n/).find((each) => each.trim() !== "");
  return oneLine(line?.trim().replace(/^#+/, "") ?? "") || fallback;
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const unknownAsk = (id: string) =>
  refused(
    `No ask has the id "${id}" on this server: it was never posted here, or it expired 7 days after its settle.`,
  );

export class AsksError extends Schema.TaggedError<AsksError>()("AsksError", {
  operation: Schema.Literals(["read", "write"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Pult could not ${this.operation} the asks.`;
  }
}

/** What a post names: an ask again by its `id`, else a new one of exactly one of `file` and `text`. */
export interface PostInput {
  readonly title?: string | undefined;
  readonly file?: string | undefined;
  readonly text?: string | undefined;
  readonly id?: string | undefined;
}

export interface ListFilter {
  readonly star?: string | undefined;
  readonly channel?: Channel | undefined;
  readonly thread?: ThreadId | undefined;
  readonly settled: boolean;
}

/** The asks of a route's answer, with the folder and its project the page opens Pult's Markdown in. */
export interface AsksView {
  readonly folder: string;
  readonly projectId: ProjectId | null;
  readonly asks: ReadonlyArray<Ask & { readonly prefix: string }>;
}

export type Action =
  | { readonly kind: "replied" }
  | { readonly kind: "snooze"; readonly until: string | null }
  | { readonly kind: "settle" }
  | { readonly kind: "unsettle" };

export interface Asks {
  readonly folder: string;
  /** The project of the asks folder, which the page hides as it hides the Stars'; null before the first `text`. */
  readonly projectId: Effect.Effect<ProjectId | null, AsksError>;
  /** `pult_ask`: posts as `poster`, `root` resolving a relative `file`; refuses what the design refuses. */
  readonly post: (
    poster: Poster,
    root: string,
    input: PostInput,
  ) => Effect.Effect<{ readonly id: string; readonly status: "posted" }, OrchestratorMcpFailure>;
  /** `pult_ask_settle`: the poster's own, silently; `mine` says whether a record's poster is the caller. */
  readonly settleOwn: (
    id: string,
    mine: (poster: Poster) => boolean,
  ) => Effect.Effect<{ readonly id: string; readonly status: "settled" }, OrchestratorMcpFailure>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<Ask>, AsksError>;
  readonly view: Effect.Effect<AsksView, AsksError>;
  /** The page's actions; undefined for an unknown ask, a string for one refused. The user's settle tells the poster. */
  readonly act: (
    id: string,
    action: Action,
  ) => Effect.Effect<Ask | undefined | { readonly refused: string }, AsksError>;
}

const iso = (at: DateTime.DateTime) => DateTime.formatIso(at);
const millis = (at: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(at));

export const make = Effect.fn("Asks.make")(function* (stars: Stars, deliver: Deliver) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const newId = (yield* SecureRandom.SecureRandom).uuidV4();
  const lock = yield* Semaphore.make(1);

  const records = path.join(config.stateDir, "plugins", "pult", "asks");
  const folder = asksFolderOf(stars.directory, path);
  const recordFile = (id: string) => path.join(records, `${id}.json`);
  const failed = (operation: AsksError["operation"]) => (cause: unknown) =>
    new AsksError({ operation, cause });
  const unavailable = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

  const write = Effect.fn("Asks.write")(
    function* (record: AskRecord) {
      yield* fs.makeDirectory(records, { recursive: true });
      yield* fs.writeFileString(recordFile(record.id), `${yield* encodeRecord(record)}\n`);
    },
    Effect.mapError(failed("write")),
  );

  /** The record and Pult's Markdown, gone. */
  const remove = Effect.fn("Asks.remove")(
    function* (record: AskRecord) {
      yield* fs.remove(recordFile(record.id), { force: true });
      if (record.kept) yield* fs.remove(record.file, { force: true });
    },
    Effect.mapError(failed("write")),
  );

  /** What a thread poster's thread says of its asks: gone once archived or deleted, else settled since when. */
  const threadState = (shell: OrchestrationV2ThreadShell | null) =>
    shell === null || shell.deletedAt !== null || shell.archivedAt !== null
      ? ("gone" as const)
      : { settled: shell.settledAt === null ? null : iso(shell.settledAt) };

  /** A record as served now, or undefined where it is gone: its thread archived or deleted, or 7 days past its settle. */
  const served = Effect.fn("Asks.served")(function* (record: AskRecord, now: number) {
    const thread =
      "thread" in record.poster
        ? threadState(yield* threads.getThreadShell(record.poster.thread))
        : { settled: null };
    if (thread === "gone") return undefined;
    const settled = record.settled ?? thread.settled;
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
    } satisfies Ask;
  });

  /** Every record with its ask as served, the gone ones removed; a file that is no record is logged and left. Under the lock. */
  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(records))) return [];
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const names = (yield* fs.readDirectory(records)).filter((name) => name.endsWith(".json"));
    const found: Array<{ readonly record: AskRecord; readonly ask: Ask }> = [];
    for (const name of names.toSorted()) {
      const file = path.join(records, name);
      const record = yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeRecord),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("An ask's record cannot be read.", { file, cause }),
            undefined,
          ),
        ),
      );
      if (record === undefined) continue;
      const ask = yield* served(record, now);
      if (ask === undefined) yield* remove(record);
      else found.push({ record, ask });
    }
    return found;
  }).pipe(Effect.mapError(failed("read")));

  const byPosted = (left: Ask, right: Ask) =>
    left.posted.localeCompare(right.posted) || left.id.localeCompare(right.id);

  const findProject = Effect.map(projects.listShells(), (shells) =>
    shells.find(
      (project) => project.archivedAt == null && path.resolve(project.workspaceRoot) === folder,
    ),
  );
  const projectId = findProject.pipe(
    Effect.map((project) => project?.id ?? null),
    Effect.mapError(failed("read")),
  );

  /** Writes Pult's Markdown for an ask, the folder registered as a project where it is not yet. */
  const keep = Effect.fn("Asks.keep")(
    function* (id: string, text: string) {
      yield* fs.makeDirectory(folder, { recursive: true });
      if ((yield* findProject) === undefined)
        yield* projects.create({
          commandId: CommandId.make(yield* newId),
          projectId: ProjectId.make(yield* newId),
          title: "Asks",
          workspaceRoot: folder,
        });
      const file = path.join(folder, `${id}.md`);
      yield* fs.writeFileString(file, text);
      return file;
    },
    Effect.mapError(failed("write")),
  );

  /** A fresh id: eight hex digits, short enough for the reply's line. */
  const freshId = Effect.gen(function* () {
    for (;;) {
      const id = (yield* newId).replaceAll("-", "").slice(0, 8);
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
        const file = input.file === undefined ? undefined : path.resolve(root, input.file);
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

  const view: Asks["view"] = Effect.gen(function* () {
    const all = yield* lock.withPermits(1)(load);
    return {
      folder,
      projectId: yield* projectId,
      asks: all.map(({ ask }) => ({ ...ask, prefix: replyPrefix(ask) })).toSorted(byPosted),
    };
  });

  /** Tells the poster of the user's settle; a notice that fails is logged, the settle standing. */
  const tellSettled = Effect.fn("Asks.tellSettled")(function* (record: AskRecord) {
    const about = `Pult, about your ask ${record.id} "${record.title}"`;
    const text = settleText(record.replied !== null);
    const key = `ask-settled:${record.id}:${record.settled}`;
    if ("star" in record.poster) {
      const star = yield* stars.get(record.poster.star);
      if (star === undefined)
        return yield* Effect.logWarning("An ask's Star is gone: its settle is told to no one.", {
          askId: record.id,
          starId: record.poster.star,
        });
      // `[From <from>, to your channel <to>]`, the notice's line.
      yield* deliver({ star, text, from: about, to: record.poster.channel, key, sender: "plugin" });
      return;
    }
    const shell = yield* threads.getThreadShell(record.poster.thread);
    if (shell === null) return;
    const id = `pult:${key}`;
    if (yield* threads.hasReceipt(CommandId.make(id))) return;
    yield* threads.sendToThread({
      projectId: shell.projectId,
      threadId: shell.id,
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      text: `[From ${about}]\n\n${text}`,
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const act: Asks["act"] = Effect.fn("Asks.act")(function* (id, action) {
    const changed:
      | undefined
      | { readonly refused: string }
      | { readonly record: AskRecord; readonly told: boolean } = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const found = (yield* load).find((each) => each.record.id === id);
        if (found === undefined) return undefined;
        const { record, ask } = found;
        const now = iso(yield* DateTime.now);
        // Its thread's settle is the thread's to undo.
        if (action.kind === "unsettle" && record.settled === null && ask.settled !== null)
          return {
            refused: "The ask reads as settled because its thread is: un-settle the thread.",
          };
        const told = action.kind === "settle" && ask.status !== "settled";
        const next: AskRecord =
          action.kind === "replied"
            ? { ...record, replied: now }
            : action.kind === "snooze"
              ? { ...record, snoozedUntil: action.until }
              : action.kind === "unsettle"
                ? { ...record, settled: null }
                : told
                  ? { ...record, settled: now }
                  : record;
        if (next !== record) yield* write(next);
        return { record: next, told };
      }),
    );
    if (changed === undefined) return undefined;
    if ("refused" in changed) return { refused: changed.refused };
    if (changed.told)
      yield* tellSettled(changed.record).pipe(
        Effect.provideService(DispatchModeLimit.DispatchModeLimit, undefined),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not tell a poster the user settled its ask.", {
            askId: id,
            cause,
          }),
        ),
      );
    const ask = yield* served(changed.record, DateTime.toEpochMillis(yield* DateTime.now)).pipe(
      Effect.mapError(failed("read")),
    );
    // Just written, and found by the load that drops what is gone.
    return ask ?? (yield* Effect.die(new Error(`The ask ${id} went as it was changed.`)));
  });

  return { folder, projectId, post, settleOwn, list, view, act } satisfies Asks;
});
