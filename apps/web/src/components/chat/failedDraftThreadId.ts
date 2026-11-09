import type { ThreadId } from "@t3tools/contracts";
import { wasBootstrapThreadDeleted } from "@t3tools/client-runtime/errors";

/** Whether the server refused to create the draft's thread because a thread with its id exists. */
function threadAlreadyExists(error: unknown): boolean {
  // The launch error carries the orchestrator's refusal as a decoded cause chain, its tag as each error's name.
  for (let cause = error, depth = 0; cause instanceof Error && depth < 8; depth++) {
    if (cause.name === "OrchestratorThreadAlreadyExistsError") return true;
    cause = cause.cause;
  }
  return false;
}

/**
 * The thread id a draft keeps after its send failed: the one it sent, so a retry is the same
 * launch, unless that id can never be launched again, its bootstrap thread deleted or the thread
 * already created (Pult: a draft left unfinalized after its thread was created, xaxis
 * `pult/issues/stale-draft-thread-id`), when it takes a fresh one.
 */
export function failedDraftThreadId(
  error: unknown,
  sentThreadId: ThreadId,
  freshThreadId: () => ThreadId,
): ThreadId {
  return wasBootstrapThreadDeleted(error) || threadAlreadyExists(error)
    ? freshThreadId()
    : sentThreadId;
}
