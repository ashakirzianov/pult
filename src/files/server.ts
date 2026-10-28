import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentRpcInput,
  EnvironmentRpcUnavailableError,
  type EnvironmentUnaryRpcTag,
  getInitialServerConfig,
  request,
} from "@t3tools/client-runtime/rpc";
import {
  type ClientGuardedRpcTag,
  type EnvironmentAuthorizationError,
  type ProjectWatchEntriesError,
  type ProjectWatchEntriesEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RpcClientError } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection } from "../connection/index.ts";
import { featuresOf, type WorkspaceServer } from "./files.ts";

/** How long a call waits for a connecting environment before it fails as unavailable. */
const READY_TIMEOUT_MS = 15_000;
const RESUBSCRIBE_DELAY = "1 second";

/**
 * A workspace's server: the page's connection to `environmentId`, as a
 * `pult:` authority names it. A call made while the environment connects, as
 * when the workbench restores `pult:` folders before the saved environments
 * are back, waits for it; an environment offline, blocked or not held fails
 * the call at once.
 */
export function environmentServer(environmentId: string): WorkspaceServer {
  /** An RPC the page sends on the environment's session. */
  const call = <Tag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(tag: Tag, input: EnvironmentRpcInput<Tag>) =>
    whenReady(environmentId).then(() => connection.run(environmentId, request(tag, input)));
  return {
    features: async () => {
      await whenReady(environmentId);
      return featuresOf(await connection.run(environmentId, getInitialServerConfig()));
    },
    listEntries: (input) => call(WS_METHODS.projectsListEntries, input),
    readFile: (input) => call(WS_METHODS.projectsReadFile, input),
    statEntry: (input) => call(WS_METHODS.projectsStatEntry, input),
    writeFile: (input) => call(WS_METHODS.projectsWriteFile, input),
    createDirectory: (input) => call(WS_METHODS.projectsCreateDirectory, input),
    deleteEntry: (input) => call(WS_METHODS.projectsDeleteEntry, input),
    renameEntry: (input) => call(WS_METHODS.projectsRenameEntry, input),
    searchEntries: (input) => call(WS_METHODS.projectsSearchEntries, input),
    searchContents: (input) => call(WS_METHODS.projectsSearchContents, input),
    // A signed download URL, valid an hour: minted per read and never handed on.
    readAsset: async (cwd, relativePath) => {
      const { relativeUrl } = await call(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "draft-workspace-file", cwd, path: relativePath },
      });
      // The bearer and its server are held together, so the bearer goes only to the server it is for.
      const credential = connection.credential(environmentId);
      if (credential === undefined) throw unavailable(environmentId);
      const response = await fetch(new URL(relativeUrl, credential.httpBaseUrl), {
        headers: { authorization: `Bearer ${credential.token}` },
      });
      if (!response.ok) {
        throw new Error(`The server refused the bytes of ${relativePath}: HTTP ${response.status}.`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    watchEntries: (cwd, listener) => {
      const stop = connection.follow(environmentId, watchStream(cwd), (item) => {
        switch (item._tag) {
          case "subscribed":
            return void listener.subscribed();
          case "changed":
            return listener.changed(item.event);
          case "gone":
            return listener.gone();
        }
      });
      return { dispose: stop };
    },
  };
}

/**
 * Resolves once the page's connection to `environmentId` is ready; rejects
 * at once for an environment offline, blocked or not held (but while the
 * page restores the saved ones), and after a wait for one that never
 * connects.
 */
export function whenReady(environmentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const environment = connection.environment(environmentId);
      if (environment?.phase === "ready") {
        resolve();
        return true;
      }
      const waiting =
        environment === undefined
          ? connection.connecting
          : environment.phase === "connecting" || environment.phase === "reconnecting";
      if (waiting) return false;
      reject(unavailable(environmentId));
      return true;
    };
    if (settle()) return;
    const stop = connection.onDidChange(() => {
      if (!settle()) return;
      clearTimeout(timer);
      stop();
    });
    const timer = setTimeout(() => {
      stop();
      reject(unavailable(environmentId));
    }, READY_TIMEOUT_MS);
  });
}

function unavailable(environmentId: string) {
  const environment = connection.environment(environmentId);
  return new EnvironmentRpcUnavailableError({
    environmentId,
    message:
      environment === undefined
        ? "Pult is not connected to this environment: connect to it to open its files."
        : (environment.error ?? `${environment.label} is ${environment.phase}.`),
  });
}


type WatchItem =
  | { readonly _tag: "subscribed" }
  | { readonly _tag: "changed"; readonly event: ProjectWatchEntriesEvent }
  | { readonly _tag: "gone" };

const subscribed: WatchItem = { _tag: "subscribed" };
const gone: WatchItem = { _tag: "gone" };

/**
 * A root's changes: a subscription on each session the supervisor opens,
 * ending for good once the root is gone.
 */
function watchStream(cwd: string): Stream.Stream<WatchItem, never, EnvironmentSupervisor.EnvironmentSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => watchSession(session.client[WS_METHODS.projectsWatchEntries]({ cwd })),
          }),
        ),
        Stream.takeUntil((item) => item._tag === "gone"),
      );
    }),
  );
}

/**
 * A root's changes on one session, `subscription` being its `watchEntries`
 * call: subscribed again whenever the server's watcher closes or the
 * subscription fails, until the root is found gone.
 */
export function watchSession(
  subscription: Stream.Stream<
    ProjectWatchEntriesEvent,
    ProjectWatchEntriesError | EnvironmentAuthorizationError | RpcClientError.RpcClientError
  >,
): Stream.Stream<WatchItem> {
  return Stream.succeed(subscribed).pipe(
    Stream.concat(
      subscription.pipe(
        Stream.map((event): WatchItem => ({ _tag: "changed", event })),
        Stream.catch((error) =>
          error._tag === "ProjectWatchEntriesError" && error.failure === "workspace_root_not_found"
            ? Stream.succeed(gone)
            : Stream.empty,
        ),
      ),
    ),
    // Spaced, since a closing watcher may answer the next subscription by
    // ending it at once, and a failing one fail it again.
    Stream.repeat(Schedule.spaced(RESUBSCRIBE_DELAY)),
  );
}
