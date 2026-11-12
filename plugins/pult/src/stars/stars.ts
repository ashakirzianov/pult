// The Stars of this server (xaxis `pult/design-durable-agent-sleep`, `pult/issues/star-channels.md`):
// found on demand from the store and the record files, kept up in their folders, their conversations,
// one current per channel, which a `pult:channel:<slug>` tag names and `user` where none does, put to
// sleep and transcribed once a minute and before one is handed to anyone. The plugin persists nothing.
import {
  CommandId,
  linkOriginIsFenced,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  DateTime,
  Effect,
  FileSystem,
  HostProcess,
  Path,
  ProjectService,
  Scheduler,
  Schema,
  Semaphore,
  ServerConfig,
  SecureRandom,
  ServerEnvironment,
  ThreadManagementService,
} from "../host.ts";
import { AGENTS_TEXT, agentsOutdated } from "./agents.ts";
import { type Ask, askName, ASKS_DIRECTORY, askTitle } from "./asks.ts";
import { type Channel, taggedChannel, USER_CHANNEL } from "./channels.ts";
import {
  AGENTS_FILE,
  CHANNELS_DIRECTORY,
  DEFAULT_STAR_FOLDER,
  INSTRUCTIONS_FILE,
  isStarRoot,
  newRecord,
  parseRecord,
  RECORD_FILE,
  type RecordFields,
  recordText,
  STAR_PROJECT_ICON,
  type StarRecord,
  STARS_DIRECTORY,
  starName,
  withRecordFields,
} from "./record.ts";
import { asleepBy, type SleepInput, type Wakefulness, wakefulness } from "./sleep.ts";
import {
  formatTranscript,
  isTranscriptName,
  parseTranscript,
  transcriptHead,
  transcriptName,
  transcriptsFolder,
} from "./transcript.ts";

/** How often the pass looks at every Star; the scheduler ticks more often. */
const PASS_INTERVAL_MS = 60_000;
/** How many of a Star's latest settled conversations each look sees to the transcripts of. */
const TRANSCRIPTS_KEPT = 10;
/** Later than any settlement: the first page of settled threads starts below it. */
const NEWEST_SETTLED = "9999-12-31T23:59:59.999Z";
/** How many settled threads one page of the search for a channel's latest reads at least. */
const SETTLED_PAGE = 25;
/** How many of the project's latest settled threads the search for a wake's model reads at most. */
const WAKE_SEARCH = 100;

/** A conversation's channel, by its first valid channel tag; `user` with none. */
const channelOf = (thread: Pick<OrchestrationV2ThreadShell, "tags">): Channel =>
  taggedChannel(thread.tags) ?? USER_CHANNEL;

export interface Star {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
  readonly root: string;
  readonly projectId: ProjectId;
}

/**
 * What `withConversation` hands its use, for the channel it names: that channel's open conversation
 * created last, and the one a wake takes its model and modes from: the newest of that channel, open
 * or ended, else of `user`, else of any channel.
 */
export interface Conversations {
  readonly current: OrchestrationV2ThreadShell | null;
  readonly newest: OrchestrationV2ThreadShell | null;
}

/** An open channel as the view serves it: its slug, its current conversation's thread, and its deadline or what holds it. */
export interface ChannelView {
  readonly slug: Channel;
  readonly threadId: ThreadId;
  readonly sleeps: { readonly at: string } | { readonly heldBy: string };
}

/** What a page draws, as `GET /stars` serves it. */
export interface StarsView {
  readonly directory: string;
  readonly hidden: ReadonlyArray<ProjectId>;
  readonly stars: ReadonlyArray<
    Star & {
      readonly instructions: string;
      /** Every open channel, `user` among them, by slug; `asleepSince`, `model` and `conversations` are `user`'s. */
      readonly channels: ReadonlyArray<ChannelView>;
      readonly asleepSince: string;
      /** The model a wake into `user` takes, the `newest` of `withConversation`'s; null before the Star's first conversation. */
      readonly model: ModelSelection | null;
      readonly conversations: ReadonlyArray<string>;
      /** By name. */
      readonly asks: ReadonlyArray<Ask>;
    }
  >;
}

export class StarsError extends Schema.TaggedError<StarsError>()("StarsError", {
  operation: Schema.Literals(["find", "create", "write-record", "look", "read"]),
  starId: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Pult could not ${this.operation} the Stars${this.starId === undefined ? "" : ` (${this.starId})`}.`;
  }
}

/** A Star's own request to sleep at the end of `runId`, made at `calledAt`. */
export interface StarSleepRequest {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly calledAt: DateTime.Utc;
}

/** A request to sleep: the Star's own, or the user's, Refresh Context, the thread alone, now. */
export type SleepRequest = StarSleepRequest | { readonly threadId: ThreadId };

/** What holds a conversation awake, as the view's `sleeps` names it. */
export type HeldBy = Extract<Wakefulness, { kind: "held" }>["by"];

/** What a look did with a conversation: settled it, or left it awake, with what holds it where something does. */
type SleepOutcome = { readonly slept: true } | { readonly slept: false; readonly heldBy?: HeldBy };

/** What the user's request answers: settled, or refused naming its hold, or the Star asleep already. */
export type SleepByHand =
  | { readonly slept: true }
  | { readonly slept: false; readonly heldBy: HeldBy }
  | { readonly slept: false; readonly asleep: true };

export interface Stars {
  readonly directory: string;
  readonly list: Effect.Effect<ReadonlyArray<Star>, StarsError>;
  readonly get: (id: string) => Effect.Effect<Star | undefined, StarsError>;
  /** The Star whose conversation the thread is, a root thread of its project no fenced link started, and its channel. */
  readonly ofThread: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly star: Star; readonly channel: Channel } | undefined, StarsError>;
  /** Under the Star's lock, once the Star is looked at: the conversations of `channel`. */
  readonly withConversation: <A, E, R>(
    star: Star,
    channel: Channel,
    use: (conversations: Conversations) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StarsError, R>;
  /** The look under the Star's lock with that conversation's deadline taken as passed: every hold applies, and the settle expects the request's run as the latest. */
  readonly sleepNow: (star: Star, request: StarSleepRequest) => Effect.Effect<void>;
  /** The user's request, Refresh Context: the look under the Star's lock with `user`'s current conversation's deadline taken as passed, every hold applying. */
  readonly sleepByHand: (star: Star) => Effect.Effect<SleepByHand, StarsError>;
  readonly view: Effect.Effect<StarsView, StarsError>;
  readonly transcript: (
    star: Star,
    name: string,
  ) => Effect.Effect<ReturnType<typeof parseTranscript>, StarsError>;
  /** A Star in a fresh folder; with `ifNone`, the one there while the server has any. */
  readonly create: (options: { readonly ifNone: boolean }) => Effect.Effect<Star, StarsError>;
  readonly upkeep: Effect.Effect<void>;
  readonly setRecord: (star: Star, fields: RecordFields) => Effect.Effect<Star, StarsError>;
}

/** The Stars directory resolved to the live install's, `~/.pult/stars`, for a server whose home is not `~/.t3`. */
export class LiveStarsRefused extends Schema.TaggedError<LiveStarsRefused>()("LiveStarsRefused", {
  baseDir: Schema.String,
  directory: Schema.String,
}) {
  override get message(): string {
    return `Pult refuses the Stars at ${this.directory}: they are the live install's, and this server's home is ${this.baseDir}, not ~/.t3. Run it with a home that is not directly under ~.`;
  }
}

/**
 * `.pult/stars` beside the server's home, or under its state for a dev run on the default home.
 * A home directly under `~` other than `~/.t3` would share the live install's Stars, so it is refused.
 */
export function starsDirectory(
  config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "stateDir">,
  home: string,
  path: Path.Path,
): Effect.Effect<string, LiveStarsRefused> {
  const baseDir = path.resolve(config.baseDir);
  const devOnDefaultHome = path.resolve(config.stateDir) === path.join(baseDir, "dev");
  const directory = devOnDefaultHome
    ? path.join(config.stateDir, STARS_DIRECTORY)
    : path.join(path.dirname(baseDir), STARS_DIRECTORY);
  const live = path.join(path.resolve(home), STARS_DIRECTORY);
  return directory === live && baseDir !== path.join(path.resolve(home), ".t3")
    ? Effect.fail(new LiveStarsRefused({ baseDir, directory }))
    : Effect.succeed(directory);
}

const isStarsError = Schema.is(StarsError);

/**
 * A conversation of the Star whose project the thread is in: a root thread no fenced link started.
 * A link paired below full access may launch threads into any project, but it may change only its
 * own work (`McpLinkOrigin`), so such a thread is left alone: never current, settled or transcribed.
 */
const isConversation = (thread: OrchestrationV2ThreadShell) =>
  thread.lineage.parentThreadId === null &&
  (thread.linkOrigin === undefined || !linkOriginIsFenced(thread.linkOrigin));

const instant = (iso: string | undefined) => {
  const parsed = iso === undefined ? undefined : DateTime.make(iso);
  return parsed?._tag === "Some" ? DateTime.toEpochMillis(parsed.value) : undefined;
};

/** The sleep rule's reading of a conversation: every channel but `user` rotates on a full context. */
const wakefulnessOf = (records: SleepInput, thread: OrchestrationV2ThreadShell) =>
  wakefulness(records, thread.promptCacheExpiresAt, {
    rotatesWhenFull: channelOf(thread) !== USER_CHANNEL,
  });

const sleepsOf = (state: Wakefulness) =>
  state.kind === "held"
    ? { heldBy: state.by }
    : { at: DateTime.formatIso(DateTime.makeUnsafe(state.at)) };

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const scheduler = yield* Scheduler.Scheduler;

  const directory = yield* starsDirectory(config, yield* HostProcess.HomeDirectory, path);
  const environmentId = yield* environment.getEnvironmentId;
  const serverLock = yield* Semaphore.make(1);
  const starLocks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (star: Star) => {
    const known = starLocks.get(star.id);
    if (known !== undefined) return known;
    const lock = Semaphore.makeUnsafe(1);
    starLocks.set(star.id, lock);
    return lock;
  };
  const random = yield* SecureRandom.SecureRandom;
  const newId = random.uuidV4();

  const readOptional = (file: string) =>
    Effect.flatMap(fs.exists(file), (there) =>
      there ? fs.readFileString(file) : Effect.undefined,
    );
  const readRecordAt = (root: string) =>
    Effect.map(readOptional(path.join(root, RECORD_FILE)), (text) =>
      text === undefined ? undefined : parseRecord(text),
    );

  /** The Stars with their projects: two folders carrying one id are no Star, and logged. */
  const find = Effect.fn("Stars.find")(
    function* () {
      const shells = yield* projects.listShells();
      const candidates = shells.filter(
        (project) =>
          project.archivedAt == null &&
          path.dirname(path.resolve(project.workspaceRoot)) === directory,
      );
      const read = yield* Effect.forEach(
        candidates,
        (project) =>
          Effect.map(readRecordAt(project.workspaceRoot), (record) =>
            record === undefined ? [] : [{ record, project }],
          ),
        { concurrency: 8 },
      );
      const found = read.flat();
      const byId = Map.groupBy(found, (each) => each.record.id);
      for (const [id, folders] of byId) {
        if (folders.length > 1)
          yield* Effect.logWarning("Two Star folders carry one id; neither is a Star.", {
            starId: id,
            roots: folders.map((each) => each.project.workspaceRoot),
          });
      }
      return found
        .filter((each) => byId.get(each.record.id)?.length === 1)
        .map(({ record, project }) => ({
          star: starOf(record, project.workspaceRoot, project.id),
          title: project.title,
        }));
    },
    Effect.mapError((cause) => new StarsError({ operation: "find", cause })),
  );

  const starOf = (record: StarRecord, root: string, projectId: ProjectId): Star => ({
    id: record.id,
    name: record.name,
    tint: record.tint,
    created: record.created,
    root,
    projectId,
  });

  const list = Effect.map(find(), (found) => found.map((each) => each.star));
  const get = (id: string) => Effect.map(list, (stars) => stars.find((star) => star.id === id));

  const setIcon = Effect.fn("Stars.setIcon")(function* (projectId: ProjectId) {
    yield* projects.update({
      commandId: CommandId.make(yield* newId),
      projectId,
      projectIcon: STAR_PROJECT_ICON,
    });
  });

  /** Makes each folder with a record and no project a project, then keeps `AGENTS.md` and titles up; each step logged and left to the next pass where it fails. */
  const keepUp = Effect.gen(function* () {
    if (!(yield* fs.exists(directory))) return;
    const entries = yield* fs.readDirectoryEntries(directory);
    const owned = new Set(
      (yield* projects.listShells()).map((project) => path.resolve(project.workspaceRoot)),
    );
    for (const entry of entries) {
      const root = path.join(directory, entry.name);
      if (entry.type !== "Directory" || entry.name.startsWith(".") || owned.has(root)) continue;
      yield* Effect.gen(function* () {
        const record = yield* readRecordAt(root);
        if (record === undefined) return;
        const project = yield* projects.create({
          commandId: CommandId.make(yield* newId),
          projectId: ProjectId.make(yield* newId),
          title: starName(record),
          workspaceRoot: root,
        });
        yield* setIcon(project.id);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not adopt a Star's folder.", { root, cause }),
        ),
      );
    }
    for (const { star, title } of yield* find()) {
      yield* Effect.gen(function* () {
        const agents = path.join(star.root, AGENTS_FILE);
        if (agentsOutdated(yield* readOptional(agents)))
          yield* fs.writeFileString(agents, AGENTS_TEXT);
        if (title !== starName(star))
          yield* projects.update({
            commandId: CommandId.make(yield* newId),
            projectId: star.projectId,
            title: starName(star),
          });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not keep a Star's folder up.", { starId: star.id, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not keep the Stars up.", { cause })),
  );
  const upkeep = serverLock.withPermits(1)(keepUp).pipe(Effect.withSpan("Stars.upkeep"));

  const openConversations = (star: Star) =>
    Effect.map(
      threads.getShellSnapshot({ projectId: star.projectId, unsettledOnly: true }),
      (snapshot) =>
        snapshot.threads
          .filter(isConversation)
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
          ),
    );

  /**
   * The project's latest settled conversations, of `channel` where it names one, the latest first;
   * with `searched`, among the project's latest that many settled threads alone.
   */
  const settledConversations = Effect.fn("Stars.settledConversations")(function* (
    star: Star,
    count: number,
    options: { readonly channel?: Channel; readonly searched?: number } = {},
  ) {
    const { channel, searched = Infinity } = options;
    const roots: OrchestrationV2ThreadShell[] = [];
    let before: { readonly settledAt: string; readonly threadId?: ThreadId } = {
      settledAt: NEWEST_SETTLED,
    };
    let read = 0;
    while (roots.length < count && read < searched) {
      const limit = Math.min(Math.max(count, SETTLED_PAGE), searched - read);
      const page = yield* threads.listOlderSettledThreads({
        before,
        projectIds: [star.projectId],
        limit,
      });
      if (page.threadIds.length === 0) break;
      read += page.threadIds.length;
      const snapshot = yield* threads.getShellSnapshot({ threadIds: page.threadIds });
      const shells = page.threadIds.flatMap((id) => {
        const shell = snapshot.threads.find((thread) => thread.id === id);
        return shell === undefined ? [] : [shell];
      });
      roots.push(
        ...shells.filter(
          (shell) =>
            isConversation(shell) && (channel === undefined || channelOf(shell) === channel),
        ),
      );
      const oldest = shells.at(-1);
      if (page.threadIds.length < limit || oldest?.settledAt == null) break;
      before = { settledAt: DateTime.formatIso(oldest.settledAt), threadId: oldest.id };
    }
    return roots.slice(0, count);
  });

  /**
   * With `requested`, a request: the deadline is waived, the holds are not; the Star's own, at the
   * end of its run, is spent by any run since or a message steered into its run after the call.
   */
  const sleepIfDue = Effect.fn("Stars.sleepIfDue")(function* (
    star: Star,
    thread: OrchestrationV2ThreadShell,
    requested: SleepRequest | undefined,
  ) {
    const records = yield* threads.getProjectThreadRecords(
      { projectId: star.projectId, threadId: thread.id },
      ["runs", "providerTurns", "runtimeRequests", "subagents"],
    );
    const latest = records.runs.toSorted((left, right) => left.ordinal - right.ordinal).at(-1);
    const state = wakefulnessOf(records, thread);
    const awake: SleepOutcome = { slept: false };
    if (state.kind === "held") return { slept: false, heldBy: state.by } satisfies SleepOutcome;
    if (requested === undefined) {
      if (!asleepBy(state, DateTime.toEpochMillis(yield* DateTime.now))) return awake;
    } else if ("runId" in requested) {
      if (latest?.id !== requested.runId) return awake;
      // A message steered into the run joins it and starts no run of its own.
      const { messages } = yield* threads.getProjectThreadRecords(
        { projectId: star.projectId, threadId: thread.id },
        ["messages"],
        { messageRunIds: [requested.runId], messageRoles: ["user"] },
      );
      const calledAt = DateTime.toEpochMillis(requested.calledAt);
      if (messages.some((message) => DateTime.toEpochMillis(message.createdAt) >= calledAt))
        return awake;
    }
    // A run that began since the read refuses the settle.
    yield* threads.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(yield* newId),
      threadId: thread.id,
      ...(latest === undefined ? {} : { expectedLatestRunId: latest.id }),
    });
    return { slept: true } satisfies SleepOutcome;
  });

  const label = Effect.map(environment.getDescriptor, (descriptor) => descriptor.label);

  /** Writes the transcript where it is missing, ends otherwise or is partial, and only when its text differs. */
  const keepTranscript = Effect.fn("Stars.keepTranscript")(function* (
    star: Star,
    thread: OrchestrationV2ThreadShell,
  ) {
    if (thread.settledAt === null) return;
    const file = path.join(
      star.root,
      transcriptsFolder(environmentId, channelOf(thread)),
      transcriptName(thread.createdAt, thread.id),
    );
    const existing = yield* readOptional(file);
    const head = existing === undefined ? undefined : transcriptHead(existing);
    if (
      head !== undefined &&
      !head.partial &&
      instant(head.ended) === DateTime.toEpochMillis(thread.settledAt)
    )
      return;
    const { projection } = yield* threads.getThreadSnapshot(thread.id);
    const contents = formatTranscript(projection, yield* label);
    if (contents === undefined || contents === existing) return;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, contents);
  });

  /**
   * Sleep for each open conversation past its deadline, then the transcripts of the latest settled,
   * oldest first; each failure logged. What became of the request's conversation, undefined where
   * it is not open; its failure fails the look once the transcripts are written.
   */
  const look = Effect.fn("Stars.look")(function* (star: Star, request?: SleepRequest) {
    const outcomes = yield* Effect.forEach(yield* openConversations(star), (thread) =>
      sleepIfDue(star, thread, thread.id === request?.threadId ? request : undefined).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Could not put a Star's conversation to sleep.", {
            starId: star.id,
            threadId: thread.id,
            cause,
          }),
        ),
        Effect.exit,
        Effect.map((exit) => ({ threadId: thread.id, exit })),
      ),
    );
    const requested = outcomes.find((each) => each.threadId === request?.threadId)?.exit;
    for (const thread of (yield* settledConversations(star, TRANSCRIPTS_KEPT)).toReversed())
      yield* keepTranscript(star, thread).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not write a Star's transcript.", {
            starId: star.id,
            threadId: thread.id,
            cause,
          }),
        ),
      );
    return requested === undefined ? undefined : yield* requested;
  });

  const conversationsOf = Effect.fn("Stars.conversationsOf")(function* (
    star: Star,
    channel: Channel,
  ) {
    const open = yield* openConversations(star);
    /** Its newest conversation, open or else ended among the latest settled; of any channel where it names none. */
    const newestOf = (of?: Channel) => {
      const current = open.find((thread) => of === undefined || channelOf(thread) === of);
      return current === undefined
        ? Effect.map(
            settledConversations(star, 1, {
              searched: WAKE_SEARCH,
              ...(of === undefined ? {} : { channel: of }),
            }),
            (settled) => settled[0] ?? null,
          )
        : Effect.succeed(current);
    };
    return {
      current: open.find((thread) => channelOf(thread) === channel) ?? null,
      newest:
        (yield* newestOf(channel)) ??
        (channel === USER_CHANNEL ? null : yield* newestOf(USER_CHANNEL)) ??
        (yield* newestOf()),
    } satisfies Conversations;
  });

  const withConversation: Stars["withConversation"] = (star, channel, use) =>
    lockOf(star).withPermits(1)(
      Effect.gen(function* () {
        const conversations = yield* look(star).pipe(
          Effect.andThen(conversationsOf(star, channel)),
          Effect.mapError((cause) => new StarsError({ operation: "look", starId: star.id, cause })),
        );
        return yield* use(conversations);
      }),
    );

  const sleepNow: Stars["sleepNow"] = (star, request) =>
    lockOf(star)
      .withPermits(1)(look(star, request))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not look at a Star.", { starId: star.id, cause }),
        ),
        Effect.withSpan("Stars.sleepNow"),
      );

  const sleepByHand: Stars["sleepByHand"] = (star) =>
    lockOf(star)
      .withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* openConversations(star)).find(
            (thread) => channelOf(thread) === USER_CHANNEL,
          );
          if (current === undefined) return { slept: false, asleep: true } as const;
          const outcome = yield* look(star, { threadId: current.id });
          // A conversation no longer open was settled by someone since the read: asleep all the same.
          if (outcome === undefined || outcome.slept) return { slept: true } as const;
          // The user's request waives the deadline, so only a hold leaves it awake.
          if (outcome.heldBy === undefined)
            return yield* Effect.die("A request by hand left an unheld conversation awake.");
          return { slept: false, heldBy: outcome.heldBy } as const;
        }),
      )
      .pipe(
        Effect.mapError((cause) => new StarsError({ operation: "look", starId: star.id, cause })),
        Effect.withSpan("Stars.sleepByHand"),
      );

  const ofThread = Effect.fn("Stars.ofThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new StarsError({ operation: "find", cause })));
    if (shell === null || !isConversation(shell)) return undefined;
    const star = (yield* list).find((each) => each.projectId === shell.projectId);
    return star === undefined ? undefined : { star, channel: channelOf(shell) };
  });

  /** The names of `user`'s transcripts, which the fold draws. */
  const transcriptNames = Effect.fn("Stars.transcriptNames")(function* (star: Star) {
    const folder = path.join(star.root, transcriptsFolder(environmentId, USER_CHANNEL));
    if (!(yield* fs.exists(folder))) return [];
    return (yield* fs.readDirectory(folder)).filter(isTranscriptName).toSorted();
  });

  /** Every `.md` file of the Star's asks, read as asked; one that fails to read counts under its name, and a folder that fails to list as none, each logged. */
  const asksOf = Effect.fn("Stars.asksOf")(function* (star: Star) {
    const folder = path.join(star.root, ASKS_DIRECTORY);
    const files = yield* Effect.flatMap(fs.exists(folder), (there) =>
      there ? fs.readDirectory(folder) : Effect.succeed([]),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("Could not list a Star's asks.", { starId: star.id, folder, cause }),
          [],
        ),
      ),
    );
    const names = files.flatMap((file) => {
      const name = askName(file);
      return name === undefined ? [] : [name];
    });
    return yield* Effect.forEach(names.toSorted(), (name) => {
      const file = path.join(folder, `${name}.md`);
      return fs.readFileString(file).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("Could not read a Star's ask.", { starId: star.id, file, cause }),
            undefined,
          ),
        ),
        Effect.map((text) => ({
          name,
          title: askTitle(name, text ?? ""),
          text: text ?? "",
          path: file,
        })),
      );
    });
  });

  const view = Effect.gen(function* () {
    const hidden = (yield* projects.listShells())
      .filter((project) => isStarRoot(project.workspaceRoot))
      .map((project) => project.id);
    const stars = yield* Effect.forEach(yield* list, (star) =>
      Effect.gen(function* () {
        // Newest first, so a channel's first is its current conversation.
        const current = new Map<Channel, OrchestrationV2ThreadShell>();
        for (const thread of yield* openConversations(star))
          if (!current.has(channelOf(thread))) current.set(channelOf(thread), thread);
        const channels = yield* Effect.forEach(
          [...current].toSorted(([left], [right]) => left.localeCompare(right)),
          ([slug, thread]) =>
            Effect.map(
              threads.getProjectThreadRecords({ projectId: star.projectId, threadId: thread.id }, [
                "runs",
                "providerTurns",
                "runtimeRequests",
                "subagents",
              ]),
              (records): ChannelView => ({
                slug,
                threadId: thread.id,
                sleeps: sleepsOf(wakefulnessOf(records, thread)),
              }),
            ),
        );
        const last = (yield* settledConversations(star, 1, { channel: USER_CHANNEL }))[0];
        const { newest } = yield* conversationsOf(star, USER_CHANNEL);
        return {
          ...star,
          instructions: path.join(star.root, INSTRUCTIONS_FILE),
          channels,
          asleepSince: last?.settledAt == null ? star.created : DateTime.formatIso(last.settledAt),
          model: newest?.modelSelection ?? null,
          conversations: yield* transcriptNames(star),
          asks: yield* asksOf(star),
        };
      }),
    );
    return { directory, hidden, stars };
  }).pipe(
    Effect.mapError((cause) => new StarsError({ operation: "read", cause })),
    Effect.withSpan("Stars.view"),
  );

  const transcript = Effect.fn("Stars.transcript")(
    function* (star: Star, name: string) {
      if (!isTranscriptName(name) || /[/\\]/.test(name)) return undefined;
      const text = yield* readOptional(
        path.join(star.root, transcriptsFolder(environmentId, USER_CHANNEL), name),
      );
      return text === undefined ? undefined : parseTranscript(text);
    },
    (effect, star) =>
      Effect.mapError(
        effect,
        (cause) => new StarsError({ operation: "read", starId: star.id, cause }),
      ),
  );

  /** The first folder of the directory with nothing at it: `star`, then `star-2` and on. */
  const freshRoot = Effect.gen(function* () {
    for (let index = 1; ; index += 1) {
      const root = path.join(
        directory,
        index === 1 ? DEFAULT_STAR_FOLDER : `${DEFAULT_STAR_FOLDER}-${index}`,
      );
      if (!(yield* fs.exists(root))) return root;
    }
  });

  const create = Effect.fn("Stars.create")(
    function* ({ ifNone }: { readonly ifNone: boolean }) {
      yield* keepUp;
      if (ifNone) {
        const there = (yield* list).toSorted((left, right) =>
          left.created.localeCompare(right.created),
        )[0];
        if (there !== undefined) return there;
      }
      const root = yield* freshRoot;
      const project = yield* projects.create({
        commandId: CommandId.make(yield* newId),
        projectId: ProjectId.make(yield* newId),
        title: "Star",
        workspaceRoot: root,
        createWorkspaceRootIfMissing: true,
      });
      yield* fs.makeDirectory(path.join(root, CHANNELS_DIRECTORY), { recursive: true });
      yield* fs.writeFileString(path.join(root, INSTRUCTIONS_FILE), "");
      yield* fs.writeFileString(path.join(root, AGENTS_FILE), AGENTS_TEXT);
      const record = newRecord(yield* newId, DateTime.formatIso(yield* DateTime.now));
      // Written last: the record is what makes the folder a Star.
      yield* fs.writeFileString(path.join(root, RECORD_FILE), recordText(record));
      yield* setIcon(project.id);
      return starOf(record, project.workspaceRoot, project.id);
    },
    Effect.mapError((cause) =>
      isStarsError(cause) ? cause : new StarsError({ operation: "create", cause }),
    ),
    (effect) => serverLock.withPermits(1)(effect),
  );

  const setRecord = Effect.fn("Stars.setRecord")(
    function* (star: Star, fields: RecordFields) {
      const file = path.join(star.root, RECORD_FILE);
      const text = yield* fs.readFileString(file);
      const written = withRecordFields(text, fields);
      const record = parseRecord(written);
      if (record?.id !== star.id)
        return yield* new StarsError({
          operation: "write-record",
          starId: star.id,
          cause: "The record no longer names this Star.",
        });
      if (written !== text) yield* fs.writeFileString(file, written);
      const project = yield* projects.getShell(star.projectId);
      if (project._tag === "Some" && project.value.title !== starName(record))
        yield* projects.update({
          commandId: CommandId.make(yield* newId),
          projectId: star.projectId,
          title: starName(record),
        });
      return starOf(record, star.root, star.projectId);
    },
    (effect, star) =>
      Effect.mapError(effect, (cause) =>
        isStarsError(cause)
          ? cause
          : new StarsError({ operation: "write-record", starId: star.id, cause }),
      ),
    (effect, star) => lockOf(star).withPermits(1)(effect),
  );

  let lastPass: number | undefined;
  const pass = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (lastPass !== undefined && now - lastPass < PASS_INTERVAL_MS) return;
    lastPass = now;
    yield* upkeep;
    for (const star of yield* list)
      yield* lockOf(star)
        .withPermits(1)(look(star))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not look at a Star.", { starId: star.id, cause }),
          ),
        );
  }).pipe(Effect.withSpan("Stars.pass"));
  yield* scheduler.register("pult-stars", pass);

  return {
    directory,
    list,
    get,
    ofThread,
    withConversation,
    sleepNow,
    sleepByHand,
    view,
    transcript,
    create,
    upkeep,
    setRecord,
  } satisfies Stars;
});
