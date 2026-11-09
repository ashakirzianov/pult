import {
  CommandId,
  OrchestrationV2ThreadLaunchError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { failedDraftThreadId } from "./failedDraftThreadId";

const sentThreadId = ThreadId.make("thread-sent");
const freshThreadId = () => ThreadId.make("thread-fresh");

function namedError(name: string, message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = name;
  return error;
}

/** The launch error as the client decodes it off the wire, its cause the server's ThreadLaunchError. */
function launchFailure(launchCause: Error) {
  const codec = Schema.toCodecJson(OrchestrationV2ThreadLaunchError);
  const encoded = Schema.encodeSync(codec)(
    new OrchestrationV2ThreadLaunchError({
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      message: "Failed to launch thread",
      cause: launchCause,
    }),
  );
  return Schema.decodeSync(codec)(JSON.parse(JSON.stringify(encoded)));
}

describe("failedDraftThreadId", () => {
  it("gives a draft whose thread already exists a fresh id, so its next send can create one", () => {
    // The stuck draft of pult/issues/stale-draft-thread-id: its id names a thread the server created from it.
    const error = launchFailure(
      namedError(
        "ThreadLaunchError",
        "Thread launch command-1 failed during create-thread.",
        namedError(
          "OrchestratorThreadAlreadyExistsError",
          `Thread ${sentThreadId} already exists. Use a new thread id.`,
        ),
      ),
    );
    expect(failedDraftThreadId(error, sentThreadId, freshThreadId)).toBe("thread-fresh");
  });

  it("keeps the sent id for any other failure, so a retry is the same launch", () => {
    const error = launchFailure(
      namedError(
        "ThreadLaunchError",
        "Thread launch command-1 failed during provision-worktree.",
        new Error("git worktree add failed"),
      ),
    );
    expect(failedDraftThreadId(error, sentThreadId, freshThreadId)).toBe("thread-sent");
    expect(failedDraftThreadId(new Error("offline"), sentThreadId, freshThreadId)).toBe(
      "thread-sent",
    );
  });
});
