// `pult_star_sleep` (xaxis `pult/issues/star-sleep-on-request.md`): a Star, from its own
// conversation, asks to fall asleep when the current turn ends. Declared through the server's
// `McpToolAccess` with `actsAsCaller`, so upstream's checks of the calling thread run unchanged.
import {
  OrchestratorMcpFailure,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  DateTime,
  Effect,
  McpInvocationContext,
  McpToolAccess,
  Schema,
  ThreadManagementService,
  Tool,
  Toolkit,
  toolkitRegistration,
} from "../host.ts";
import { starName } from "./record.ts";
import type { Star, Stars } from "./stars.ts";

/** How long a request waits for its turn to end; a run outlasting it keeps the Star awake. */
const TURN_WAIT_MS = 24 * 60 * 60_000;

const StarSleepTool = Tool.make("pult_star_sleep", {
  description:
    "For a Star, the user's personal agent in Pult, in its own conversation only: fall asleep when this turn ends, so the next message wakes you in a fresh thread. Call it as the last thing you do in a turn. You stay awake if the turn fails, another message follows it, or a task you delegated from this conversation is still running; ask again at the end of a later turn. Any other thread is refused.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    star: Schema.Struct({ id: Schema.String, name: Schema.String }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Fall asleep at turn end")
  .annotate(Tool.Destructive, false);

const StarSleepToolkit = Toolkit.make(StarSleepTool);

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * What a request does once taken: waits for the caller's run and, if it completed, has the Stars
 * look with this conversation's deadline waived. A run that did not complete spends it.
 */
export const afterTurn = Effect.fn("PultTools.afterTurn")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  stars: Stars,
  star: Star,
  turn: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly calledAt: DateTime.Utc;
  },
) {
  const ended = yield* threads.waitForThread({
    projectId: turn.projectId,
    threadId: turn.threadId,
    runId: turn.runId,
    timeoutMs: TURN_WAIT_MS,
  });
  if (ended.timedOut || ended.run?.status !== "completed") return;
  yield* stars.sleepNow(star, {
    threadId: turn.threadId,
    runId: turn.runId,
    calledAt: turn.calledAt,
  });
});

/** The tool's registration, to build in the plugin's activation once everything else is up. */
export const make = Effect.fn("PultTools.makeSleep")(function* (stars: Stars) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scope = yield* Effect.scope;
  const unavailable = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

  const sleepAtTurnEnd = Effect.fn("PultTools.sleepAtTurnEnd")(function* () {
    // A message steered into this turn from now on was not read when the Star asked.
    const calledAt = yield* DateTime.now;
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const caller = yield* McpInvocationContext.requireThreadScope(invocation, "Falling asleep");
    const threadId = caller.thread.threadId;
    const star = yield* stars.ofThread(threadId).pipe(Effect.mapError(unavailable));
    if (star === undefined)
      return yield* refused(
        "pult_star_sleep is for a Star's own conversation, and this thread is none: nothing was done.",
      );
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.activeRunId === null)
      return yield* refused(
        "pult_star_sleep acts at the end of the turn it is called in, and this thread has no turn on: nothing was done.",
      );
    yield* afterTurn(threads, stars, star, {
      projectId: shell.projectId,
      threadId,
      runId: shell.activeRunId,
      calledAt,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A Star's request to sleep failed.", {
          starId: star.id,
          threadId,
          cause,
        }),
      ),
      Effect.forkIn(scope),
    );
    return {
      star: { id: star.id, name: starName(star) },
      message: `Star "${starName(star)}" falls asleep when this turn ends, unless the turn fails, another turn follows it or a thread below this one still works.`,
    };
  });

  return toolkitRegistration(
    StarSleepToolkit,
    McpToolAccess.toLayer(StarSleepToolkit, {
      pult_star_sleep: McpToolAccess.actsAsCaller(sleepAtTurnEnd),
    }),
  );
});
