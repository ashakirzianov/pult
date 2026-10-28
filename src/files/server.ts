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

import { connection, type ShellEnvironment } from "../connection/index.ts";
import { featuresOf, type WorkspaceServer } from "./files.ts";

/** How long a call waits for a connecting page before it fails as unavailable. */
const READY_TIMEOUT_MS = 15_000;
const RESUBSCRIBE_DELAY = "1 second";

/** An RPC the page sends on the environment's session. */
function call<Tag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(tag: Tag, input: EnvironmentRpcInput<Tag>) {
  return whenReady().then(() => connection.run(request(tag, input)));
}

/**
 * The workspace's server: the page's connection. A call made while the page
 * connects, as when the workbench restores `pult:` folders before the saved
 * environment is back, waits for it; a page offline, blocked or holding no
 * environment fails the call at once.
 */
export const connectionServer: WorkspaceServer = {
  features: async () => {
    await whenReady();
    return featuresOf(await connection.run(getInitialServerConfig()));
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
    // The bearer and its server are set together, so the bearer goes only to the server it is for.
    const credential = connection.credential;
    if (credential === undefined) throw unavailable(connection.environment);
    const response = await fetch(new URL(relativeUrl, credential.httpBaseUrl), {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    if (!response.ok) {
      throw new Error(`The server refused the bytes of ${relativePath}: HTTP ${response.status}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  watchEntries: (cwd, listener) => {
    const stop = connection.follow(watchStream(cwd), (item) => {
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

/** Resolves once the page is connected; rejects at once for a page offline, blocked or with no environment, and after a wait for one that never connects. */
export function whenReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      const environment = connection.environment;
      if (environment?.phase === "ready") {
        resolve();
        return true;
      }
      const waiting =
        environment === null
          ? connection.connecting
          : environment.phase === "connecting" || environment.phase === "reconnecting";
      if (waiting) return false;
      reject(unavailable(environment));
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
      reject(unavailable(connection.environment));
    }, READY_TIMEOUT_MS);
  });
}

function unavailable(environment: ShellEnvironment | null) {
  return new EnvironmentRpcUnavailableError({
    environmentId: environment?.environmentId ?? "",
    message:
      environment === null
        ? "Pult is not connected to an environment."
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
