// A conversation's whole history, for its transcript (xaxis
// `pult/issues/star-sleep`). The socket's `orchestration.getThreadProjection`
// answers a window of the latest turns (the server's
// `THREAD_HISTORY_SNAPSHOT_ROW_LIMIT` rows), which the sleep rule may read
// but a transcript may not; the environment's HTTP snapshot,
// `GET /api/orchestration/threads/:threadId`, is the whole projection, every
// message and item of the thread, in the same shape.
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "@t3tools/client-runtime/state/environment-http-auth";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { withPreparedConnection } from "../connection/index.ts";

/** How long the snapshot may take: a long thread's is large, so as long as upstream's transcript fetch waits. */
const TIMEOUT_MS = 60_000;

/** Reads the thread's whole projection from its environment. */
export function readWholeProjection(environmentId: string, threadId: string) {
  const params = { threadId: ThreadId.make(threadId) };
  return withPreparedConnection(environmentId, (prepared) =>
    executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer: Option.none(),
      group: "orchestration",
      method: "GET",
      url: (urls) => urls.threadSnapshot({ params }),
      timeoutMs: TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.threadSnapshot({ params, headers: withOrchestrationProtocolHeader(headers) }),
    }).pipe(Effect.map((snapshot) => snapshot.projection)),
  );
}
