// A conversation's whole history, for its transcript (xaxis
// `pult/issues/star-sleep`), apart from the workbench so
// `node --test src/stars/history.test.ts` can run it. The socket's
// `orchestration.getThreadProjection` answers a window of the latest turns
// (the server's `THREAD_HISTORY_SNAPSHOT_ROW_LIMIT` rows), which the sleep
// rule may read but a transcript may not; the environment's HTTP snapshot,
// `GET /api/orchestration/threads/:threadId`, is the whole projection, every
// message and item of the thread, in the same shape.
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The environment's bearer and where its HTTP API is. */
export interface HttpCredential {
  readonly httpBaseUrl: string;
  readonly token: string;
}

/** The URL of the thread's whole snapshot under the environment's base URL, a path of it kept. */
export function threadSnapshotUrl(httpBaseUrl: string, threadId: string): URL {
  const base = httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`;
  return new URL(`api/orchestration/threads/${encodeURIComponent(threadId)}`, base);
}

/** The snapshot's body as the server's HTTP API encodes it, JSON through the schema's JSON codec. */
export const decodeThreadSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);

/** Reads the thread's whole projection from its environment. */
export async function readWholeProjection(
  credential: HttpCredential,
  threadId: string,
): Promise<OrchestrationV2ThreadProjection> {
  const response = await fetch(threadSnapshotUrl(credential.httpBaseUrl, threadId), {
    headers: {
      authorization: `Bearer ${credential.token}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    },
  });
  if (!response.ok)
    throw new Error(`The server refused the thread's history: HTTP ${response.status}.`);
  return decodeThreadSnapshot(await response.json()).projection;
}
