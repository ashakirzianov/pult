// The Stars of this server (xaxis `pult/design-durable-agent-sleep`): found on demand from the
// project store and the record files, created and kept up in their folders, their conversations
// put to sleep and their transcripts written once a minute and before a Star's conversation is
// handed to anyone. The plugin persists nothing.
import {
  CommandId,
  linkOriginIsFenced,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  DateTime,
  Effect,
  FileSystem,
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
import { type Ask, askName, askOf, ASKS_DIRECTORY } from "./asks.ts";
import {
  AGENTS_FILE,
  CONVERSATIONS_DIRECTORY,
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
import { asleepBy, type Wakefulness, wakefulness } from "./sleep.ts";
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

export interface Star {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
  readonly root: string;
  readonly projectId: ProjectId;
}

/** What `withConversation` hands its use: the open conversation created last, and the conversation settled last. */
export interface Conversations {
  readonly current: OrchestrationV2ThreadShell | null;
  readonly last: OrchestrationV2ThreadShell | null;
}

/** What a page draws, as `GET /stars` serves it. */
export interface StarsView {
  readonly directory: string;
  readonly hidden: ReadonlyArray<ProjectId>;
  readonly stars: ReadonlyArray<
    Star & {
      readonly instructions: string;
      readonly conversation: {
        readonly threadId: ThreadId;
        readonly sleeps: { readonly at: string } | { readonly heldBy: string };
      } | null;
      readonly asleepSince: string;
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
export interface SleepRequest {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly calledAt: DateTime.Utc;
}

export interface Stars {
  readonly directory: string;
  readonly list: Effect.Effect<ReadonlyArray<Star>, StarsError>;
  readonly get: (id: string) => Effect.Effect<Star | undefined, StarsError>;
  /** The Star whose conversation the thread is: a root thread of its project no fenced link started. */
  readonly ofThread: (threadId: ThreadId) => Effect.Effect<Star | undefined, StarsError>;
  /** Under the Star's lock, once the Star is looked at. */
  readonly withConversation: <A, E, R>(
    star: Star,
    use: (conversations: Conversations) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StarsError, R>;
  /** The look under the Star's lock with that conversation's deadline taken as passed: every hold applies, and the settle expects the request's run as the latest. */
  readonly sleepNow: (star: Star, request: SleepRequest) => Effect.Effect<void>;
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

/** `.pult/stars` beside the server's home, or under its state for a dev run on the default home. */
export function starsDirectory(
  config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "stateDir">,
  path: Path.Path,
): string {
  const devOnDefaultHome = path.resolve(config.stateDir) === path.resolve(config.baseDir, "dev");
  return devOnDefaultHome
    ? path.join(config.stateDir, STARS_DIRECTORY)
    : path.join(path.dirname(path.resolve(config.baseDir)), STARS_DIRECTORY);
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

  const directory = starsDirectory(config, path);
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

  /** The project's latest settled conversations, the latest first. */
  const settledConversations = Effect.fn("Stars.settledConversations")(function* (
    star: Star,
    count: number,
  ) {
    const roots: OrchestrationV2ThreadShell[] = [];
    let before: { readonly settledAt: string; readonly threadId?: ThreadId } = {
      settledAt: NEWEST_SETTLED,
    };
    while (roots.length < count) {
      const page = yield* threads.listOlderSettledThreads({
        before,
        projectIds: [star.projectId],
        limit: count,
      });
      if (page.threadIds.length === 0) break;
      const snapshot = yield* threads.getShellSnapshot({ threadIds: page.threadIds });
      const shells = page.threadIds.flatMap((id) => {
        const shell = snapshot.threads.find((thread) => thread.id === id);
        return shell === undefined ? [] : [shell];
      });
      roots.push(...shells.filter(isConversation));
      const oldest = shells.at(-1);
      if (page.threadIds.length < count || oldest?.settledAt == null) break;
      before = { settledAt: DateTime.formatIso(oldest.settledAt), threadId: oldest.id };
    }
    return roots.slice(0, count);
  });

  /** With `requested`, the Star's own request at the end of its run: the deadline is waived, the holds are not, and any run since, or message steered into its run after the call, spends it. */
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
    const state = wakefulness(records, thread.promptCacheExpiresAt);
    if (requested === undefined) {
      if (!asleepBy(state, DateTime.toEpochMillis(yield* DateTime.now))) return;
    } else {
      if (state.kind !== "deadline" || latest?.id !== requested.runId) return;
      // A message steered into the run joins it and starts no run of its own.
      const { messages } = yield* threads.getProjectThreadRecords(
        { projectId: star.projectId, threadId: thread.id },
        ["messages"],
        { messageRunIds: [requested.runId], messageRoles: ["user"] },
      );
      const calledAt = DateTime.toEpochMillis(requested.calledAt);
      if (
        messages.some(
          (message) =>
            message.role === "user" &&
            message.runId === requested.runId &&
            DateTime.toEpochMillis(message.createdAt) >= calledAt,
        )
      )
        return;
    }
    // A run that began since the read refuses the settle.
    yield* threads.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(yield* newId),
      threadId: thread.id,
      ...(latest === undefined ? {} : { expectedLatestRunId: latest.id }),
    });
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
      transcriptsFolder(environmentId),
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

  /** Sleep for each open conversation past its deadline, then the transcripts of the latest settled, oldest first; each failure logged. */
  const look = Effect.fn("Stars.look")(function* (star: Star, request?: SleepRequest) {
    for (const thread of yield* openConversations(star))
      yield* sleepIfDue(star, thread, thread.id === request?.threadId ? request : undefined).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not put a Star's conversation to sleep.", {
            starId: star.id,
            threadId: thread.id,
            cause,
          }),
        ),
      );
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
  });

  const conversationsNow = (star: Star) =>
    Effect.all({
      current: Effect.map(openConversations(star), (open) => open[0] ?? null),
      last: Effect.map(settledConversations(star, 1), (settled) => settled[0] ?? null),
    });

  const withConversation: Stars["withConversation"] = (star, use) =>
    lockOf(star).withPermits(1)(
      Effect.gen(function* () {
        const conversations = yield* look(star).pipe(
          Effect.andThen(conversationsNow(star)),
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

  const ofThread = Effect.fn("Stars.ofThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new StarsError({ operation: "find", cause })));
    if (shell === null || !isConversation(shell)) return undefined;
    return (yield* list).find((star) => star.projectId === shell.projectId);
  });

  const transcriptNames = Effect.fn("Stars.transcriptNames")(function* (star: Star) {
    const folder = path.join(star.root, transcriptsFolder(environmentId));
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
        Effect.map((text) => askOf(name, file, text)),
      );
    });
  });

  const view = Effect.gen(function* () {
    const hidden = (yield* projects.listShells())
      .filter((project) => isStarRoot(project.workspaceRoot))
      .map((project) => project.id);
    const stars = yield* Effect.forEach(yield* list, (star) =>
      Effect.gen(function* () {
        const { current, last } = yield* conversationsNow(star);
        const conversation =
          current === null
            ? null
            : {
                threadId: current.id,
                sleeps: sleepsOf(
                  wakefulness(
                    yield* threads.getProjectThreadRecords(
                      { projectId: star.projectId, threadId: current.id },
                      ["runs", "providerTurns", "runtimeRequests", "subagents"],
                    ),
                    current.promptCacheExpiresAt,
                  ),
                ),
              };
        return {
          ...star,
          instructions: path.join(star.root, INSTRUCTIONS_FILE),
          conversation,
          asleepSince: last?.settledAt == null ? star.created : DateTime.formatIso(last.settledAt),
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
        path.join(star.root, transcriptsFolder(environmentId), name),
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
      yield* fs.makeDirectory(path.join(root, CONVERSATIONS_DIRECTORY), { recursive: true });
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
    view,
    transcript,
    create,
    upkeep,
    setRecord,
  } satisfies Stars;
});
