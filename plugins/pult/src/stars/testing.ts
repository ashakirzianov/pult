// Fakes of the server's project and thread stores, its committed events, launches, startup, environment,
// scheduler, usage limits, previews, port discovery and source control (a settled copy's cleanup, the kept
// xaxis checkout's suite bringing the real driver), for the Stars' tests and the plugin's: a server whose home is
// `<tmp>/.t3`, its Stars in `<tmp>/.pult/stars`.
import {
  type ChatAttachment,
  type CommandId,
  type DiscoveredLocalServer,
  type MessageHeader,
  type ModelSelection,
  messageHeaderOf,
  MessageId,
  type OrchestrationMessageContext,
  type OrchestrationProjectShell,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type PreviewStopLocalServerInput,
  type ProjectId,
  type ProjectWatchEntriesEvent,
  RunId,
  type ServerProvider,
  ThreadId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import {
  v2Projection,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  DateTime,
  DispatchModeLimit,
  DocumentText,
  Effect,
  FileSystem,
  Layer,
  Path,
  PortScanner,
  PreviewManager,
  ProjectService,
  ProviderRegistry,
  Scheduler,
  ServerConfig,
  ServerEnvironment,
  ServerRuntimeStartup,
  ServerSettings,
  Stream,
  ThreadLaunchGuard,
  ThreadLaunchService,
  ThreadManagementService,
  UsageLimitSources,
  VcsStatusBroadcaster,
  WorkspaceEntries,
  XaxisVcsDriver,
} from "../host.ts";

export const at = (iso: string) => DateTime.makeUnsafe(iso);

const ON: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** What a fake took, in order; `taken(count)` waits until it has taken `count` in all. */
function recorder<T>() {
  const items: T[] = [];
  const waiters: Array<{ count: number; resume: () => void }> = [];
  const push = (item: T) => {
    items.push(item);
    for (const waiter of waiters.filter((each) => items.length >= each.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resume();
    }
  };
  const taken = (count: number) =>
    Effect.callback<void>((resume) => {
      if (items.length >= count) resume(Effect.void);
      else waiters.push({ count, resume: () => resume(Effect.void) });
    });
  return { items, push, taken };
}

/** The project store, in memory: `create` makes the folder where asked and refuses a root taken. */
function fakeProjects(fs: FileSystem.FileSystem) {
  const shells: OrchestrationProjectShell[] = [];
  const service = {
    listShells: () => Effect.sync(() => [...shells]),
    getShell: (projectId: ProjectId) =>
      Effect.sync(() => {
        const shell = shells.find((each) => each.id === projectId);
        return shell === undefined
          ? { _tag: "None" as const }
          : { _tag: "Some" as const, value: shell };
      }),
    create: Effect.fn("FakeProjects.create")(function* (input: {
      projectId: ProjectId;
      title: string;
      workspaceRoot: string;
      createWorkspaceRootIfMissing?: boolean;
    }) {
      if (shells.some((each) => each.workspaceRoot === input.workspaceRoot))
        return yield* Effect.die(new Error("Workspace already belongs to a project."));
      if (input.createWorkspaceRootIfMissing === true)
        yield* fs.makeDirectory(input.workspaceRoot, { recursive: true });
      const shell = {
        id: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-11-10T12:00:00.000Z",
        updatedAt: "2026-11-10T12:00:00.000Z",
      } satisfies OrchestrationProjectShell;
      shells.push(shell);
      return { ...shell, deletedAt: null };
    }),
    update: (input: { projectId: ProjectId; title?: string; projectIcon?: unknown }) =>
      Effect.sync(() => {
        const index = shells.findIndex((each) => each.id === input.projectId);
        const shell = shells[index];
        if (shell === undefined) throw new Error("no such project");
        shells[index] = {
          ...shell,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.projectIcon === undefined
            ? {}
            : { projectIcon: input.projectIcon as OrchestrationProjectShell["projectIcon"] }),
        };
        return { ...shells[index], deletedAt: null };
      }),
  };
  return { shells, service };
}

interface FakeThread {
  shell: OrchestrationV2ThreadShell;
  runs: OrchestrationV2Run[];
  subagents: OrchestrationV2Subagent[];
  providerTurns: OrchestrationV2ProviderTurn[];
  /** The conversation's messages, as the projection records them. */
  messages: OrchestrationV2ConversationMessage[];
}

/** A message the store took, with the dispatch's fields and the mode limit it ran under. */
export interface FakeMessage {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId | undefined;
  readonly text: string;
  /** The header its context carries (`messageHeader.ts`), null for none. */
  readonly header: MessageHeader | null;
  readonly senderThreadId: ThreadId | undefined;
  readonly createdBy: string;
  readonly creationSource: string;
  readonly limit: DispatchModeLimit.DispatchModeLimitValue | undefined;
  /** A message's attachments and its picked model, which only the user's carry. */
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection | undefined;
}

/**
 * The thread store, in memory: a settle refuses a run other than the expected latest; a command id
 * with a receipt replays and changes nothing; a message starts an idle thread's run and queues
 * behind a running one; a wait for a run answers its state at once, timed out while it is on.
 */
function fakeThreads() {
  const threads: FakeThread[] = [];
  const settles: ThreadId[] = [];
  const settleWaiters: Array<{ count: number; resume: () => void }> = [];
  const receipts = new Set<string>();
  const messages: FakeMessage[] = [];
  /** Each subscription to the committed events, in order: offer an event to it, or end or fail it. */
  const events = recorder<{
    readonly queue: Parameters<
      Parameters<typeof Stream.callback<OrchestrationV2DomainEvent>>[0]
    >[0];
  }>();
  const byId = (threadId: ThreadId) => threads.find((each) => each.shell.id === threadId);
  const projection = (thread: FakeThread): OrchestrationV2ThreadProjection => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id: thread.shell.id,
      projectId: thread.shell.projectId,
      title: thread.shell.title,
      createdAt: thread.shell.createdAt,
      settledOverride: thread.shell.settledOverride,
      settledAt: thread.shell.settledAt,
    },
    runs: thread.runs,
    subagents: thread.subagents,
    providerTurns: thread.providerTurns,
    messages: thread.messages,
  });
  /** Takes a message into the thread: a run starts where none is on, else one queues behind it. */
  const take = Effect.fn("FakeThreads.take")(function* (
    thread: FakeThread,
    message: Omit<FakeMessage, "threadId" | "limit">,
  ) {
    receipts.add(message.commandId);
    messages.push({
      ...message,
      threadId: thread.shell.id,
      limit: yield* DispatchModeLimit.DispatchModeLimit,
    });
    const on = thread.runs.some((each) => each.status === "running");
    const taken = {
      ...run(`${thread.shell.id}-run-${thread.runs.length + 1}`, on ? "queued" : "running"),
      threadId: thread.shell.id,
      ordinal: thread.runs.length + 1,
    };
    thread.runs.push(taken);
    return { run: taken, delivery: on ? ("queued" as const) : ("started" as const) };
  });
  const service = {
    hasReceipt: (commandId: CommandId) => Effect.sync(() => receipts.has(commandId)),
    // Every provider is on for every project.
    isProviderInstanceEnabledForProject: () => Effect.succeed(true),
    sendToThread: Effect.fn("FakeThreads.sendToThread")(function* (input: {
      commandId: CommandId;
      threadId: ThreadId;
      messageId: MessageId;
      senderThreadId?: ThreadId;
      text: string;
      attachments: ReadonlyArray<ChatAttachment>;
      modelSelection?: ModelSelection;
      context?: OrchestrationMessageContext;
      mode: string;
      createdBy: string;
      creationSource: string;
    }) {
      const thread = byId(input.threadId);
      if (thread === undefined || input.mode !== "queue")
        return yield* Effect.die(new Error("unexpected send"));
      if (receipts.has(input.commandId))
        return yield* Effect.die(new Error("a replayed send reached the store"));
      const taken = yield* take(thread, {
        commandId: input.commandId,
        messageId: input.messageId,
        text: input.text,
        header: messageHeaderOf(input.context),
        senderThreadId: input.senderThreadId,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        attachments: input.attachments,
        modelSelection: input.modelSelection,
      });
      // The message as stored, which the intake reads to release the uploads it did not keep.
      return { ...taken, message: { attachments: input.attachments } };
    }),
    getShellSnapshot: (options: {
      location?: "active" | "archive";
      projectId?: ProjectId;
      unsettledOnly?: boolean;
      worktreePath?: string;
      threadIds?: ReadonlyArray<ThreadId>;
    }) =>
      Effect.sync(() => ({
        threads: threads
          .map((each) => each.shell)
          .filter(
            (shell) =>
              shell.deletedAt === null &&
              (options.location === undefined ||
                (options.location === "active") === (shell.archivedAt === null)) &&
              (options.projectId === undefined || shell.projectId === options.projectId) &&
              (options.worktreePath === undefined || shell.worktreePath === options.worktreePath) &&
              (options.threadIds === undefined || options.threadIds.includes(shell.id)) &&
              (options.unsettledOnly !== true || shell.settledOverride !== "settled"),
          ),
      })),
    /** The thread's row, a deleted one's included, as the store keeps it; its subagents if asked. */
    getThreadRecords: (threadId: ThreadId, fields: ReadonlyArray<string>) =>
      fields.every((field) => field === "subagents")
        ? Effect.sync(() => ({
            thread: byId(threadId)!.shell,
            subagents: byId(threadId)?.subagents ?? [],
          }))
        : Effect.die(new Error(`unexpected records read: ${fields.join(", ")}`)),
    streamDomainEvents: Stream.callback<OrchestrationV2DomainEvent>((queue) =>
      Effect.sync(() => events.push({ queue })),
    ),
    listOlderSettledThreads: (query: {
      before: { settledAt: string; threadId?: ThreadId };
      projectIds?: ReadonlyArray<ProjectId>;
      limit: number;
    }) =>
      Effect.sync(() => ({
        threadIds: threads
          .map((each) => each.shell)
          .filter(
            (shell) =>
              shell.settledOverride === "settled" &&
              shell.settledAt !== null &&
              shell.lineage.relationshipToParent !== "subagent" &&
              (query.projectIds?.includes(shell.projectId) ?? true) &&
              DateTime.formatIso(shell.settledAt) < query.before.settledAt,
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.settledAt ?? at("1970-01-01T00:00:00Z")) -
              DateTime.toEpochMillis(left.settledAt ?? at("1970-01-01T00:00:00Z")),
          )
          .slice(0, query.limit)
          .map((shell) => shell.id),
        counts: [],
      })),
    /** Honours the message filters the plugin passes, as the store's query does. */
    getProjectThreadRecords: (
      input: { threadId: ThreadId },
      _fields?: ReadonlyArray<string>,
      filter?: {
        messageRunIds?: ReadonlyArray<RunId>;
        messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
      },
    ) =>
      Effect.sync(() => {
        const records = projection(byId(input.threadId) ?? threads[0]!);
        return {
          ...records,
          messages: records.messages.filter(
            (message) =>
              (filter?.messageRunIds === undefined ||
                (message.runId !== null && filter.messageRunIds.includes(message.runId))) &&
              (filter?.messageRoles === undefined || filter.messageRoles.includes(message.role)),
          ),
        };
      }),
    getThreadSnapshot: (threadId: ThreadId) =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: 0,
        projection: projection(byId(threadId)!),
      })),
    // A deleted thread has no shell, as the store reads it.
    getThreadShell: (threadId: ThreadId) =>
      Effect.sync(() => {
        const shell = byId(threadId)?.shell;
        return shell === undefined || shell.deletedAt !== null ? null : shell;
      }),
    dispatch: Effect.fn("FakeThreads.dispatch")(function* (command: {
      type: string;
      threadId: ThreadId;
      expectedLatestRunId?: RunId;
    }) {
      const thread = byId(command.threadId);
      if (command.type !== "thread.settle" || thread === undefined)
        return yield* Effect.die(new Error("unexpected command"));
      if (command.expectedLatestRunId !== thread.runs.at(-1)?.id)
        return yield* Effect.die(new Error("a run began since"));
      settles.push(command.threadId);
      thread.shell = {
        ...thread.shell,
        settledOverride: "settled",
        settledAt: yield* DateTime.now,
      };
      for (const waiter of settleWaiters.filter((each) => settles.length >= each.count))
        waiter.resume();
      return { sequence: 1 };
    }),
    waitForThread: (input: { threadId: ThreadId; runId?: RunId }) =>
      Effect.sync(() => {
        const ran = byId(input.threadId)?.runs.find((each) => each.id === input.runId) ?? null;
        return {
          threadId: input.threadId,
          run: ran,
          timedOut: ran !== null && ON.has(ran.status),
        };
      }),
  };
  /** A thread, tagged as a conversation of `main`, a record's default channel, unless `shell` names its tags. */
  const add = (
    projectId: ProjectId,
    id: string,
    shell: Partial<OrchestrationV2ThreadShell>,
    runs: OrchestrationV2Run[] = [],
  ) => {
    const thread: FakeThread = {
      shell: {
        ...v2ThreadShell,
        tags: ["pult:channel:main"],
        id: ThreadId.make(id),
        projectId,
        title: id,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(id),
        },
        ...shell,
      },
      runs,
      subagents: [],
      providerTurns: [],
      messages: [],
    };
    threads.push(thread);
    return thread;
  };
  /** Once the store has taken `count` settles in all. */
  const settled = (count: number) =>
    Effect.callback<void>((resume) => {
      if (settles.length >= count) resume(Effect.void);
      else settleWaiters.push({ count, resume: () => resume(Effect.void) });
    });
  return { threads, settles, settled, receipts, messages, events, add, take, byId, service };
}

/** The input a launch got, as the fake recorded it. */
export type FakeLaunch = Parameters<
  ThreadLaunchService.ThreadLaunchService["Service"]["launch"]
>[0];

/**
 * Launches, in memory: the thread and its first message each take a receipt, so a repeat replays
 * (`resumed`) and one cut between the two (`cutNext`) finishes the message on the next call. A
 * launch with no receipt runs through the registered guard, as the server's does; `launches` holds
 * those that went ahead.
 */
function fakeLaunches(
  threads: ReturnType<typeof fakeThreads>,
  guards: ThreadLaunchGuard.ThreadLaunchGuard["Service"],
) {
  const launches: FakeLaunch[] = [];
  const threadOf = new Map<string, ThreadId>();
  const state = { cutNext: false };
  const launchNow = Effect.fn("FakeLaunches.launchNow")(function* (input: FakeLaunch) {
    launches.push(input);
    const known = threadOf.get(input.commandId);
    const thread =
      known === undefined
        ? threads.add(input.projectId, `launched-${threadOf.size + 1}`, {
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            createdAt: yield* DateTime.now,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            tags: [...(input.tags ?? [])],
          })
        : threads.byId(known)!;
    threadOf.set(input.commandId, thread.shell.id);
    threads.receipts.add(input.commandId);
    if (state.cutNext) {
      state.cutNext = false;
      return yield* new ThreadLaunchService.ThreadLaunchError({
        operation: "dispatch-message",
        commandId: input.commandId,
        projectId: input.projectId,
        cause: "cut short",
      });
    }
    const messageCommandId = `${input.commandId}:initial-message` as CommandId;
    const resumed = threads.receipts.has(messageCommandId);
    if (!resumed && input.initialMessage !== undefined)
      yield* threads.take(thread, {
        commandId: messageCommandId,
        messageId: input.initialMessage.messageId,
        text: input.initialMessage.text,
        header: messageHeaderOf(input.initialMessage.context),
        senderThreadId: input.initialMessage.senderThreadId,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
    return { threadId: thread.shell.id, projection: v2Projection, resumed };
  });
  const service = {
    launch: Effect.fn("FakeLaunches.launch")(function* (input: FakeLaunch) {
      const guard = threads.receipts.has(input.commandId) ? undefined : yield* guards.current;
      if (guard === undefined) return yield* launchNow(input);
      return yield* guard(input, launchNow(input)).pipe(
        Effect.catchTags({
          ThreadLaunchRefusal: (refusal) =>
            Effect.fail(
              new ThreadLaunchService.ThreadLaunchError({
                operation: "guard",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: refusal,
              }),
            ),
        }),
      );
    }),
  };
  return { launches, state, service };
}

export const run = (id: string, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: v2Projection.thread.id,
  ordinal: 1,
  providerInstanceId: v2ThreadShell.providerInstanceId,
  modelSelection: v2ThreadShell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: at("2026-11-10T12:00:00.000Z"),
  startedAt: at("2026-11-10T12:00:01.000Z"),
  completedAt: status === "running" ? null : at("2026-11-10T12:01:00.000Z"),
  checkpointId: null,
  contextHandoffId: null,
});

/** A user's message on `runId`, as the projection records one. */
export const userMessage = (
  id: string,
  runId: string,
  createdAt: string,
): OrchestrationV2ConversationMessage => ({
  createdBy: "user",
  creationSource: "web",
  id: MessageId.make(id),
  threadId: v2Projection.thread.id,
  runId: RunId.make(runId),
  nodeId: null,
  role: "user",
  text: id,
  attachments: [],
  streaming: false,
  createdAt: at(createdAt),
  updatedAt: at(createdAt),
});

export const fakeServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "pult-stars-" }));
  const projects = fakeProjects(fs);
  const threads = fakeThreads();
  /** The server's launch hook point; the plugin's activation registers its guard here, a test of its own Stars with `guards.register`. */
  const guards = yield* ThreadLaunchGuard.make;
  const launches = fakeLaunches(threads, guards);
  const sources = new Map<string, Effect.Effect<void>>();
  /** Each subscription to the watch, in order: offer a batch to it, or end or fail it. */
  const watches: Array<{
    readonly cwd: string;
    readonly queue: Parameters<Parameters<typeof Stream.callback<ProjectWatchEntriesEvent>>[0]>[0];
  }> = [];
  /** What the server's providers and usage hubs hold now, as `pult_usage_limits` reads them; each refresh
   * asked for, in order, runs `onRefresh` for the providers' (set it to change what they hold). */
  const limits: {
    providers: ReadonlyArray<ServerProvider>;
    sources: ReadonlyArray<UsageLimitSourceSnapshot>;
    refreshed: Array<"providers" | "sources">;
    onRefresh: () => void;
  } = { providers: [], sources: [], refreshed: [], onRefresh: () => {} };
  /** The threads whose previews closed; a close for a thread of `failFor` dies. */
  const previews = { closed: recorder<ThreadId>(), failFor: new Set<ThreadId>() };
  /** The settled copies the xaxis driver was asked to clean, each removed. */
  const copies = recorder<{
    readonly cwd: string;
    readonly path: string;
    readonly activeThreadIds: ReadonlyArray<string>;
  }>();
  /** The listening servers each scan finds, and those stopped. */
  const ports = {
    servers: [] as Array<DiscoveredLocalServer>,
    stopped: recorder<PreviewStopLocalServerInput>(),
  };
  const layer = Layer.mergeAll(
    ServerConfig.layerTest(tmp, path.join(tmp, ".t3")),
    Layer.succeed(
      ProjectService.ProjectService,
      projects.service as unknown as ProjectService.ProjectService["Service"],
    ),
    Layer.succeed(
      ThreadManagementService.ThreadManagementService,
      threads.service as unknown as ThreadManagementService.ThreadManagementService["Service"],
    ),
    Layer.succeed(ThreadLaunchGuard.ThreadLaunchGuard, guards),
    Layer.succeed(
      ThreadLaunchService.ThreadLaunchService,
      launches.service as unknown as ThreadLaunchService.ThreadLaunchService["Service"],
    ),
    Layer.succeed(
      ServerRuntimeStartup.ServerRuntimeStartup,
      // Startup recovery has ended.
      {
        awaitCommandReady: Effect.void,
      } as unknown as ServerRuntimeStartup.ServerRuntimeStartup["Service"],
    ),
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed("env-1" as never),
        getDescriptor: Effect.succeed({ environmentId: "env-1", label: "MacBook" } as never),
      }),
    ),
    Layer.succeed(
      Scheduler.Scheduler,
      Scheduler.Scheduler.of({
        register: Effect.fn("FakeScheduler.register")(function* <E, R>(
          name: string,
          runDueWork: Effect.Effect<void, E, R>,
        ) {
          const context = yield* Effect.context<R>();
          sources.set(name, Effect.provideContext(runDueWork, context).pipe(Effect.orDie));
        }),
      }),
    ),
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.sync(() => limits.providers),
      refresh: () =>
        Effect.sync(() => {
          limits.refreshed.push("providers");
          limits.onRefresh();
          return limits.providers;
        }),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    Layer.succeed(UsageLimitSources.UsageLimitSources, {
      current: Effect.sync(() => limits.sources),
      refresh: Effect.sync(() => void limits.refreshed.push("sources")),
    } as unknown as UsageLimitSources.UsageLimitSources["Service"]),
    Layer.mock(PreviewManager.PreviewManager)({
      close: (input: { threadId: ThreadId }) =>
        previews.failFor.has(input.threadId)
          ? Effect.die(new Error("closing the previews failed"))
          : Effect.sync(() => previews.closed.push(input.threadId)),
    }),
    Layer.mock(PortScanner.PortDiscovery)({
      scan: () => Effect.sync(() => ports.servers),
      trackAgent: () => () => undefined,
      stopServer: (input: PreviewStopLocalServerInput) =>
        Effect.sync(() => ports.stopped.push(input)),
    }),
    ServerSettings.layerTest(),
    Layer.mock(XaxisVcsDriver.XaxisVcsDriver)({
      cleanSettledCopy: (input) =>
        Effect.sync(() => {
          copies.push(input);
          return { removed: true } as const;
        }),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
    // Read only to claim a text upload, which no test sends.
    Layer.mock(DocumentText.DocumentText)({}),
    Layer.succeed(WorkspaceEntries.WorkspaceEntries, {
      watch: (input: { cwd: string }) =>
        Stream.callback<ProjectWatchEntriesEvent>((queue) =>
          Effect.sync(() => {
            watches.push({ cwd: input.cwd, queue });
          }),
        ),
    } as unknown as WorkspaceEntries.WorkspaceEntries["Service"]),
  );
  const directory = path.join(tmp, ".pult", "stars");
  /** A source the plugin registered with the scheduler, as its tick runs it. */
  const runSource = (name: string) =>
    Effect.suspend(() => sources.get(name) ?? Effect.die(new Error(`no source ${name}`)));
  /** The Stars' pass, as the tick runs it. */
  const runPass = runSource("pult-stars");
  return {
    layer,
    projects,
    threads,
    launches,
    guards,
    limits,
    previews,
    ports,
    copies,
    tmp,
    directory,
    runPass,
    runSource,
    watches,
  };
});
