// What settling or archiving a thread does beyond upstream's settle, subscribed to its committed
// `thread.settled` and `thread.archived` (`pult/decisions`, `thread-events`, `settle-closes-previews`,
// `settle-stops-agent-servers`, `settle-cascades-to-subagents`, `xaxis-copy-cleanup`). A reaction acts
// only while the thread is still settled (or archived); a failing one is logged, and the rest go on.
import {
  CommandId,
  linkOriginIsFenced,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectScripts, settleProjectScript } from "@t3tools/shared/projectScripts";

import {
  Cause,
  Effect,
  FileSystem,
  Path,
  PortScanner,
  PreviewManager,
  ProjectService,
  SecureRandom,
  ServerSettings,
  Stream,
  ThreadManagementService,
  XaxisVcsDriver,
} from "../host.ts";

export const make = Effect.fn("SettledThreads.make")(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const previews = yield* PreviewManager.PreviewManager;
  const ports = yield* PortScanner.PortDiscovery;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const xaxis = yield* XaxisVcsDriver.XaxisVcsDriver;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The thread now, while it is still settled and not deleted. */
  const stillSettled = (threadId: ThreadId) =>
    Effect.map(threads.getThreadShell(threadId), (thread) =>
      thread !== null && thread.deletedAt === null && thread.settledOverride === "settled"
        ? thread
        : null,
    );

  /** Settling a thread, automatic settles included, stops the listening servers its agent
   * started, which nothing else reaches on macOS once their shell returns. Terminals' servers
   * are upstream's settle's. */
  const stopAgentServers = Effect.fn("SettledThreads.stopAgentServers")(function* (
    threadId: ThreadId,
  ) {
    for (const server of yield* ports.scan()) {
      if (server.agent?.threadId !== threadId || server.pid === null) continue;
      const target = { pid: server.pid, port: server.port };
      yield* ports.stopServer(target).pipe(
        Effect.catchTags({
          PreviewStopLocalServerError: ({ reason }) =>
            reason === "not-found"
              ? Effect.void
              : Effect.logWarning("stopping a settled thread's server failed", {
                  threadId,
                  ...target,
                  reason,
                }),
        }),
      );
    }
  });

  /** Its subagent threads settle, whose idle rows would otherwise outlive it; un-settling it
   * restores none. Each child's own settle cascades to its subagents in turn. */
  const settleSubagents = Effect.fn("SettledThreads.settleSubagents")(function* (
    threadId: ThreadId,
  ) {
    const { subagents } = yield* threads.getThreadRecords(threadId, ["subagents"]);
    for (const childThreadId of new Set(subagents.map((subagent) => subagent.childThreadId))) {
      if (childThreadId === null) continue;
      // A child the server refuses to settle, one still running, is logged and left as it is.
      yield* Effect.gen(function* () {
        const child = yield* threads.getThreadShell(childThreadId);
        if (
          child === null ||
          child.settledOverride === "settled" ||
          child.archivedAt !== null ||
          child.deletedAt !== null
        )
          return;
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(
            `server:settle-subagent:${childThreadId}:${yield* random.uuidV4()}`,
          ),
          threadId: childThreadId,
        });
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("settling a settled thread's subagent failed", {
              threadId,
              childThreadId,
              cause: Cause.pretty(cause),
            }),
        ),
      );
    }
  });

  /** Its copy of a project kept in xaxis goes once no other thread is on it and it holds no work;
   * a kept one is logged with why. A copy a settle script runs in is the script's, a fenced link's
   * is not ours to touch, a project's own root is no copy, and a subagent's shared worktree is its
   * parent's, a deleted parent's included. */
  const cleanCopy = Effect.fn("SettledThreads.cleanCopy")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    const worktreePath = thread.worktreePath;
    if (worktreePath === null) return;
    if (thread.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin)) return;
    if (!(yield* fs.exists(path.join(worktreePath, XaxisVcsDriver.XAXIS_MARKER)))) return;
    const projectShells = yield* projects.listShells();
    const project = projectShells.find((candidate) => candidate.id === thread.projectId);
    if (
      project === undefined ||
      projectShells.some((candidate) => candidate.workspaceRoot === worktreePath)
    )
      return;
    if (
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.parentThreadId !== null &&
      (yield* threads.getThreadRecords(thread.lineage.parentThreadId, [])).thread.worktreePath ===
        worktreePath
    )
      return;
    if (settleProjectScript(resolveProjectScripts(yield* settings.getSettings, project)) !== null)
      return;
    const { threads: sharing } = yield* threads.getShellSnapshot({
      location: "active",
      worktreePath,
    });
    const activeThreadIds = sharing
      .filter((other) => other.id !== thread.id && other.settledOverride !== "settled")
      .map((other) => other.id);
    const copy = yield* xaxis.cleanSettledCopy({
      cwd: project.workspaceRoot,
      path: worktreePath,
      activeThreadIds,
    });
    yield* copy.removed
      ? Effect.logInfo("removed a settled thread's copy", { threadId: thread.id, worktreePath })
      : Effect.logInfo("kept a settled thread's copy", {
          threadId: thread.id,
          worktreePath,
          reason: copy.reason,
        });
  });

  /** One reaction to one event: its failure is logged with the event's type and thread. */
  const react = <A, E, R>(
    event: OrchestrationV2DomainEvent,
    reaction: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("a thread's settle reaction failed", {
            event: event.type,
            threadId: event.threadId,
            reaction,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  /** A reaction that runs only while the thread is still settled, read again just before it. */
  const whileSettled = <E, R>(
    event: OrchestrationV2DomainEvent,
    reaction: string,
    act: (thread: OrchestrationV2ThreadShell) => Effect.Effect<void, E, R>,
  ) =>
    react(
      event,
      reaction,
      Effect.flatMap(stillSettled(event.threadId), (thread) =>
        thread === null ? Effect.void : act(thread),
      ),
    );

  const onSettled = Effect.fn("SettledThreads.onSettled")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    yield* whileSettled(event, "previews", (thread) => previews.close({ threadId: thread.id }));
    yield* whileSettled(event, "agent servers", (thread) => stopAgentServers(thread.id));
    yield* whileSettled(event, "subagents", (thread) => settleSubagents(thread.id));
    yield* whileSettled(event, "xaxis copy", cleanCopy);
  });

  const onArchived = (event: OrchestrationV2DomainEvent) =>
    react(
      event,
      "previews",
      Effect.gen(function* () {
        const thread = yield* threads.getThreadShell(event.threadId);
        if (thread === null || thread.deletedAt !== null || thread.archivedAt === null) return;
        yield* previews.close({ threadId: event.threadId });
      }),
    );

  // Live from activation, in sequence order, one event at a time; nothing missed while the server
  // was down is replayed. A failure of the stream itself ends the subscription, as upstream's
  // reactors do.
  yield* Effect.forkScoped(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      switch (event.type) {
        case "thread.settled":
          return onSettled(event);
        case "thread.archived":
          return onArchived(event);
        default:
          return Effect.void;
      }
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logError("the settle reactions' event stream failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );
});
