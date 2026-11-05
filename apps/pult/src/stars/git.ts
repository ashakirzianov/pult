import {
  requestGuarded,
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the page runs none of upstream's atoms the client guard reads; the server checks the scopes itself.
  RpcPermissionGuard,
} from "@t3tools/client-runtime/rpc";
import { type GitStackedAction, ProjectId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { actionStarted, commitFailure, commitProgress } from "../changes/commit.ts";
import { changesServer } from "../changes/server.ts";
import { connection } from "../connection/index.ts";
import { whenReady } from "../files/server.ts";
import { RECORD_FILE } from "./record.ts";
import type { HomeStatus } from "./sync.ts";

const serverChecks = { authorize: () => Effect.void };

/** The server checks the scopes itself; the page runs none of upstream's atoms the client guard reads. */
const unguarded = Effect.provideService(RpcPermissionGuard, serverChecks);

const withoutTrailingSlash = (path: string) => path.replace(/[/\\]+$/, "");

/**
 * The server's git calls a Star's sync makes on `environmentId`: the changes
 * view's status, pull and stacked action (`src/changes/server.ts`), and
 * `vcs.init`, `vcs.setRemote` (the fork's; a stock server fails it) and the
 * clone it alone needs. Each waits for a connecting environment, as the
 * files' calls do.
 */
export function starGit(environmentId: string) {
  const changes = changesServer(environmentId);
  return {
    /** The folder's repository as the server's status reads it, and whether the folder is its root. */
    status: async (root: string): Promise<HomeStatus> => {
      const status = await changes.status(root);
      const rootPath = status.workingTree.rootPath;
      return {
        ownRepository:
          status.isRepo &&
          rootPath !== undefined &&
          withoutTrailingSlash(rootPath) === withoutTrailingSlash(root),
        branch: status.refName,
        head: status.headSha ?? null,
        hasUpstream: status.hasUpstream,
        ahead: status.aheadCount,
        behind: status.behindCount,
        uncommitted: status.workingTree.files.map((file) => file.path),
      };
    },
    init: async (root: string) => {
      await whenReady(environmentId);
      return connection.run(
        environmentId,
        unguarded(requestGuarded(WS_METHODS.vcsInit, { cwd: root })),
      );
    },
    /**
     * Points `origin` at `url`, or removes it for null, fetching it when
     * asked, which on a failure puts it back as it was; its URL before, null
     * where it had none.
     */
    setRemote: async (root: string, url: string | null, fetch: boolean) => {
      await whenReady(environmentId);
      const input = { cwd: root, url, fetch };
      return (
        await connection.run(
          environmentId,
          unguarded(requestGuarded(WS_METHODS.vcsSetRemote, input)),
        )
      ).previousUrl;
    },
    pull: (root: string) => changes.pull(root),
    /** The server's stacked action with a message of the page's, its commit every change or `filePaths` alone, failing with the server's reason. */
    stacked: async (
      root: string,
      action: GitStackedAction,
      message: string,
      projectId: string | null,
      filePaths?: [string, ...string[]],
    ) => {
      let progress = actionStarted("");
      try {
        await changes.runStackedAction(
          {
            actionId: globalThis.crypto.randomUUID(),
            cwd: root,
            action,
            commitMessage: message,
            ...(projectId === null ? {} : { projectId: ProjectId.make(projectId) }),
            ...(filePaths === undefined ? {} : { filePaths }),
          },
          (event) => {
            progress = commitProgress(progress, event);
          },
        );
      } catch (error) {
        throw new Error(commitFailure(progress, error), { cause: error });
      }
      if (progress.failure !== null) throw new Error(progress.failure);
    },
    /** The origin's `AGENTS.md` on `branch`, as last fetched; undefined where the origin has no such branch or file. */
    originRecord: (root: string, branch: string) =>
      changes
        .diffFileContents({
          cwd: root,
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: `origin/${branch}`,
          headRef: null,
          oldPath: RECORD_FILE,
          newPath: RECORD_FILE,
        })
        .then(
          (contents) => contents.oldContents,
          () => undefined,
        ),
    /** Clones `url` into `destination`, a host path that is missing or empty. */
    clone: async (url: string, destination: string) => {
      await whenReady(environmentId);
      const input = { remoteUrl: url, destinationPath: destination };
      return connection.run(
        environmentId,
        unguarded(requestGuarded(WS_METHODS.sourceControlCloneRepository, input)),
      );
    },
  };
}
