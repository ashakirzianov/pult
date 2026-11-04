import {
  request,
  requestGuarded,
  RpcPermissionGuard,
  runStreamGuarded,
} from "@t3tools/client-runtime/rpc";
import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsPullResult,
  type VcsStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connection } from "../connection/index.ts";
import { whenReady } from "../files/server.ts";

/** The client's guard reads the session's scopes through upstream's atoms, which the page does not run; the server checks them itself. */
const serverChecks = { authorize: () => Effect.void };

/**
 * The server's review calls the changes view uses, on the page's connection
 * to `environmentId`: a project's diff sources with their files, a file's
 * two sides, a turn's patch, a checkout's status against its upstream, a
 * pull, and a commit or push. A call waits for a connecting
 * environment, as the files' do.
 */
export function changesServer(environmentId: string) {
  return {
    diffPreview: async (input: ReviewDiffPreviewInput): Promise<ReviewDiffPreviewResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(WS_METHODS.reviewGetDiffPreview, input));
    },
    diffFileContents: async (
      input: ReviewDiffFileContentsInput,
    ): Promise<ReviewDiffFileContentsResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(WS_METHODS.reviewGetDiffFileContents, input));
    },
    turnDiff: async (
      input: OrchestrationGetTurnDiffInput,
    ): Promise<OrchestrationGetTurnDiffResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, input));
    },
    /** The checkout's status, its upstream fetched first while the server's automatic fetch is on. */
    status: async (cwd: string): Promise<VcsStatusResult> => {
      await whenReady(environmentId);
      return connection.run(environmentId, request(WS_METHODS.vcsRefreshStatus, { cwd }));
    },
    /** A fast-forward pull of the checkout's branch from its upstream; a diverged branch fails. */
    pull: async (cwd: string): Promise<VcsPullResult> => {
      await whenReady(environmentId);
      return connection.run(
        environmentId,
        requestGuarded(WS_METHODS.vcsPull, { cwd }).pipe(
          Effect.provideService(RpcPermissionGuard, serverChecks),
        ),
      );
    },
    /**
     * The server's stacked git action, a stream: its progress events handed
     * to `onEvent` as they come, settling when the server ends the stream.
     * On failure the server sends `action_failed` first, then fails it.
     */
    runStackedAction: async (
      input: GitRunStackedActionInput,
      onEvent: (event: GitActionProgressEvent) => void,
    ): Promise<void> => {
      await whenReady(environmentId);
      return connection.run(
        environmentId,
        runStreamGuarded(WS_METHODS.gitRunStackedAction, input).pipe(
          Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
          Effect.provideService(RpcPermissionGuard, serverChecks),
        ),
      );
    },
  };
}
