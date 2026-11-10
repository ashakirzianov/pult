// Fakes of the server's project and thread stores and its environment and scheduler, for the
// Stars' tests and the plugin's: a server whose home is `<tmp>/.t3`, its Stars in `<tmp>/.pult/stars`.
import {
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import {
  v2Projection,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Path,
  ProjectService,
  Scheduler,
  ServerConfig,
  ServerEnvironment,
  ThreadManagementService,
} from "../host.ts";

export const at = (iso: string) => DateTime.makeUnsafe(iso);

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
}

/** The thread store, in memory: a settle refuses a run other than the expected latest. */
function fakeThreads() {
  const threads: FakeThread[] = [];
  const settles: ThreadId[] = [];
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
  });
  const service = {
    getShellSnapshot: (options: {
      projectId?: ProjectId;
      unsettledOnly?: boolean;
      threadIds?: ReadonlyArray<ThreadId>;
    }) =>
      Effect.sync(() => ({
        threads: threads
          .map((each) => each.shell)
          .filter(
            (shell) =>
              (options.projectId === undefined || shell.projectId === options.projectId) &&
              (options.threadIds === undefined || options.threadIds.includes(shell.id)) &&
              (options.unsettledOnly !== true || shell.settledOverride !== "settled"),
          ),
      })),
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
    getProjectThreadRecords: (input: { threadId: ThreadId }) =>
      Effect.sync(() => projection(byId(input.threadId) ?? threads[0]!)),
    getThreadSnapshot: (threadId: ThreadId) =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: 0,
        projection: projection(byId(threadId)!),
      })),
    getThreadShell: (threadId: ThreadId) => Effect.sync(() => byId(threadId)?.shell ?? null),
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
      return { sequence: 1 };
    }),
  };
  const add = (
    projectId: ProjectId,
    id: string,
    shell: Partial<OrchestrationV2ThreadShell>,
    runs: OrchestrationV2Run[] = [],
  ) => {
    const thread: FakeThread = {
      shell: {
        ...v2ThreadShell,
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
    };
    threads.push(thread);
    return thread;
  };
  return { threads, settles, add, service };
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

export const fakeServer = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "pult-stars-" }));
  const projects = fakeProjects(fs);
  const threads = fakeThreads();
  let pass: Effect.Effect<void> | undefined;
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
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed("env-1" as never),
        getDescriptor: Effect.succeed({ label: "MacBook" } as never),
      }),
    ),
    Layer.succeed(
      Scheduler.Scheduler,
      Scheduler.Scheduler.of({
        register: Effect.fn("FakeScheduler.register")(function* <E, R>(
          _name: string,
          runDueWork: Effect.Effect<void, E, R>,
        ) {
          const context = yield* Effect.context<R>();
          pass = Effect.provideContext(runDueWork, context).pipe(Effect.orDie);
        }),
      }),
    ),
  );
  const directory = path.join(tmp, ".pult", "stars");
  /** The source the plugin registered with the scheduler, as its tick runs it. */
  const runPass = Effect.suspend(() => pass ?? Effect.die(new Error("no pass registered")));
  return { layer, projects, threads, tmp, directory, runPass };
});
