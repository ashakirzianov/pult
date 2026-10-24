import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  type ConnectionCredential,
  type ConnectionProfile,
  Connectivity,
  CredentialStore,
  type NetworkStatus,
  type PlatformConnectionRegistration,
  ProfileStore,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities, Persistence, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import type { PageSocket } from "./socket.ts";

const unsupported = (detail: string) => Effect.fail(new ConnectionBlockedError({ reason: "unsupported", detail }));

/** Events of `target` as a stream of `value`, for the runtime's network and wakeup sources. */
function domEvents<A>(target: EventTarget, events: ReadonlyArray<[string, A]>) {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        events.map(([type, value]) => {
          const listener = () => Queue.offerUnsafe(queue, value);
          target.addEventListener(type, listener);
          return () => target.removeEventListener(type, listener);
        }),
      ),
      (stops) => Effect.sync(() => stops.forEach((stop) => stop())),
    ).pipe(Effect.asVoid),
  );
}

const networkStatus = (): NetworkStatus => (navigator.onLine ? "online" : "offline");

/** In memory: the page holds the one environment `connection.ts` registers, and keeps no offline copy. */
const layerStores = Layer.mergeAll(
  Layer.sync(ProfileStore.ConnectionProfileStore, () => {
    const profiles = new Map<string, ConnectionProfile>();
    return ProfileStore.make({
      get: (id) => Effect.sync(() => Option.fromUndefinedOr(profiles.get(id))),
      put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
      remove: (id) => Effect.sync(() => void profiles.delete(id)),
    });
  }),
  Layer.sync(CredentialStore.ConnectionCredentialStore, () => {
    const credentials = new Map<string, ConnectionCredential>();
    return CredentialStore.make({
      get: (id) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(id))),
      put: (id, credential) => Effect.sync(() => void credentials.set(id, credential)),
      remove: (id) => Effect.sync(() => void credentials.delete(id)),
    });
  }),
  Layer.succeed(Persistence.ConnectionTargetStore, { list: Effect.succeed([]), listDisabled: Effect.succeed([]) }),
  Layer.succeed(Persistence.ConnectionRegistrationStore, {
    register: () => Effect.void,
    setRoutes: () => Effect.void,
    remove: () => Effect.void,
    setEnabled: () => Effect.void,
  }),
  Layer.succeed(Persistence.EnvironmentCacheStore, {
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  }),
  TokenStore.layer({ get: () => Effect.succeedNone, put: () => Effect.void, remove: () => Effect.void }),
);

const NO_CONNECT = "T3 Connect is not available in Pult.";

const layerCapabilities = Layer.mergeAll(
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "Pult", deviceType: "desktop" },
    scopes: AuthStandardClientScopes,
  }),
  Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.CloudSession, { identity: Effect.succeedNone, clerkToken: unsupported(NO_CONNECT) }),
  Layer.succeed(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
    provision: () => unsupported("SSH environments are not available in Pult."),
    prepare: () => unsupported("SSH environments are not available in Pult."),
    disconnect: () => Effect.void,
  }),
  Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
    thumbprint: Effect.fail(new ManagedRelay.ManagedRelayDpopKeyLoadError({ keyStore: "indexed-db", cause: NO_CONNECT })),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({ method: input.method, url: input.url, cause: NO_CONNECT }),
      ),
  }),
);

/**
 * What the vendored connection runtime asks of the page: fetch, the page's one
 * socket (`socket.ts`), the browser's network events, the page coming back to
 * the foreground as the wakeup, and the environment the shell connects as the
 * one platform registration, the way a desktop-local backend is registered.
 * T3 Connect (an empty relay URL disables the relay client), SSH and a primary
 * local environment are off, as in pult-extension's host (`platform.ts`).
 */
export function platformLayer(
  socket: PageSocket,
  registrations: Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>>,
) {
  return ManagedRelay.layer({ relayUrl: "", clientId: "t3-web" }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
        Layer.succeed(Socket.WebSocketConstructor, socket.webSocketConstructor),
        Connectivity.layer({
          status: Effect.sync(networkStatus),
          changes: domEvents<NetworkStatus>(window, [
            ["online", "online"],
            ["offline", "offline"],
          ]),
        }),
        Wakeups.layer({ changes: domEvents(window, [["focus", "application-active" as const]]) }),
        layerStores,
        layerCapabilities,
        Layer.succeed(PlatformConnectionSource.PlatformConnectionSource, { registrations }),
      ),
    ),
  );
}
