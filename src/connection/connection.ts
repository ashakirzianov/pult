import { getService, ISecretStorageService } from "@codingame/monaco-vscode-api";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  Connection,
  type ConnectionCatalogEntry,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PlatformConnectionRegistration,
  presentConnectionState,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import type { ResolvedRemotePairingTarget } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { platformLayer } from "./platform.ts";
import { probe } from "./probe.ts";
import { PageSocket } from "./socket.ts";

export type ConnectionPhase = "connecting" | "ready" | "reconnecting" | "offline" | "blocked";

/** The page's environment as its connection stands: what the shell, the thread view and the extension see. */
export interface ShellEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly phase: ConnectionPhase;
  /** Why the connection is not ready and, when only the user can fix it, how. */
  readonly error: string | null;
}

/** The environment the page connects to after a reload, with its bearer, in the workbench's secret storage. */
const Saved = Schema.Struct({ profile: BearerConnectionProfile, token: Schema.String });
const SAVED_KEY = "pult-shell.environment";
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Saved));

function registration(saved: typeof Saved.Type): BearerConnectionRegistration {
  const { profile, token } = saved;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: profile.environmentId,
      label: profile.label,
      connectionId: profile.connectionId,
    }),
    profile,
    credential: new BearerConnectionCredential({ token }),
  });
}

/**
 * The page's one connection to an environment (`pult/decisions`,
 * `connection-owner`, moved from the extension host into the shell): the
 * vendored runtime, with the environment the shell connects as its one
 * platform registration, so the registry's supervisor dials the page's one
 * socket and reconnects it. The thread view runs on this runtime's services
 * (`context`), the thread model follows its shell snapshot and the thread
 * commands run their RPCs on it (`run`); the extension reaches it through
 * `bridge.ts`.
 */
class ShellConnection {
  readonly socket = new PageSocket();
  private readonly registrations = Effect.runSync(
    SubscriptionRef.make<ReadonlyArray<PlatformConnectionRegistration>>([]),
  );
  private saved: typeof Saved.Type | undefined;
  /** Until `restore` settles, the page may yet connect to the environment saved before the reload. */
  private restoring = true;
  private current: ShellEnvironment | null = null;
  private readonly listeners = new Set<() => void>();
  readonly runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Connection.layerWithOptions({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true }),
      // The shell snapshot's HTTP load, for the thread model (`src/threads/model.ts`).
      ShellSnapshotLoader.layer,
    ).pipe(Layer.provideMerge(platformLayer(this.socket, SubscriptionRef.changes(this.registrations)))),
  );

  constructor() {
    this.runtime.runFork(
      followEnvironment((next) => {
        this.current = next;
        for (const listener of this.listeners) listener();
      }),
    );
  }

  get environment(): ShellEnvironment | null {
    return this.current;
  }

  /**
   * The environment's bearer and the server it belongs to, for requests the
   * shell sends on a bridged client's behalf: set together, the moment the
   * page switches, so the bearer never goes to the server it is not for.
   */
  get credential() {
    const saved = this.saved;
    return saved && { label: saved.profile.label, httpBaseUrl: saved.profile.httpBaseUrl, token: saved.token };
  }

  /**
   * Whether the page is about to connect without the user: it is restoring
   * the environment saved before the reload, or holds one whose state the
   * registry has not published yet.
   */
  get connecting(): boolean {
    return this.current === null && (this.restoring || this.saved !== undefined);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs an effect on the environment's supervisor: RPCs go to its live
   * session, and fail with `EnvironmentRpcUnavailableError` while there is
   * none or the page holds no environment.
   */
  run<A, E>(effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>): Promise<A> {
    const environmentId = this.saved?.profile.environmentId;
    if (environmentId === undefined) {
      return Promise.reject(new EnvironmentRpcUnavailableError({ environmentId: "", message: "Pult is not connected to an environment." }));
    }
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(Effect.flatMap((registry) => registry.run(environmentId, effect))),
    );
  }

  /**
   * Runs a stream on the environment's supervisor, handing each item to
   * `onItem`, until the returned function stops it or the page leaves that
   * environment.
   */
  follow<A>(stream: Stream.Stream<A, never, EnvironmentSupervisor.EnvironmentSupervisor>, onItem: (item: A) => void): () => void {
    const environmentId = this.saved?.profile.environmentId;
    if (environmentId === undefined) return () => {};
    const fiber = this.runtime.runFork(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry.followStream(environmentId, stream).pipe(Stream.runForEach((item) => Effect.sync(() => onItem(item)))),
        ),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }

  /** The runtime's services, for the thread view's state runtime. */
  context() {
    return this.runtime.context();
  }


  /** Connects the environment saved before the reload, if any. Called once the workbench is up. */
  async restore(): Promise<void> {
    try {
      const secrets = await getService(ISecretStorageService);
      const saved = decodeSaved(await secrets.get(SAVED_KEY));
      if (Option.isSome(saved)) await this.use(saved.value);
    } finally {
      this.restoring = false;
      for (const listener of this.listeners) listener();
    }
  }

  /**
   * Probes the target from the page, whose origin the server sees, and only if
   * it answers saves it and connects, replacing any environment the page held.
   * Fails with the probe's `ProbeError`.
   */
  async connect(target: ResolvedRemotePairingTarget): Promise<void> {
    const probed = await this.runtime.runPromise(probe({ target, origin: window.location.origin }));
    const saved = { profile: probed.profile, token: probed.credential.token };
    const secrets = await getService(ISecretStorageService);
    await secrets.set(SAVED_KEY, encodeSaved(saved));
    await this.use(saved);
  }

  /** Closes the connection and forgets the environment and its bearer. */
  async disconnect(): Promise<void> {
    const secrets = await getService(ISecretStorageService);
    await secrets.delete(SAVED_KEY);
    await this.use(undefined);
  }

  /** Retries a connection waiting between attempts. */
  retryNow(): Promise<void> {
    const environmentId = this.saved?.profile.environmentId;
    if (environmentId === undefined) return Promise.resolve();
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(Effect.flatMap((registry) => registry.retryNow(environmentId))),
    );
  }

  private async use(saved: typeof Saved.Type | undefined): Promise<void> {
    this.saved = saved;
    // A new bearer for the same environment needs a new registration, so the old one goes first.
    await this.runtime.runPromise(SubscriptionRef.set(this.registrations, []));
    if (saved !== undefined) await this.runtime.runPromise(SubscriptionRef.set(this.registrations, [registration(saved)]));
  }
}

function followEnvironment(publish: (next: ShellEnvironment | null) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Option.fromUndefinedOr(entries.keys().next().value)),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed(null),
          onSome: (environmentId) =>
            registry.followStream(
              environmentId,
              Stream.unwrap(
                Effect.gen(function* () {
                  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                  return Stream.zipLatestAll(
                    SubscriptionRef.changes(registry.entries).pipe(
                      Stream.map((entries) => entries.get(environmentId)),
                      Stream.filter((entry) => entry !== undefined),
                    ),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(Stream.map(([entry, state]) => present(entry, state)));
                }),
              ),
            ),
        }),
      ),
      Stream.runForEach((next) => Effect.sync(() => publish(next))),
    );
  });
}

function present(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
): ShellEnvironment {
  const profile = Option.getOrUndefined(Option.filter(entry.profile, Schema.is(BearerConnectionProfile)));
  const base = {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    httpBaseUrl: profile?.httpBaseUrl ?? "",
    wsBaseUrl: profile?.wsBaseUrl ?? "",
  };
  const connection = presentConnectionState(state);
  // An unsupported server blocks the supervisor; the registry then switches
  // the entry off and keeps the verdict there (pult-extension's `presentation.ts`).
  if (!entry.enabled || connection.phase === "unsupported") {
    const reason = entry.unsupportedReason ?? connection.error ?? `${entry.target.label} does not support this Pult.`;
    return { ...base, phase: "blocked", error: `${reason} Disconnect, then connect again after the update.` };
  }
  const phase = (
    { connected: "ready", available: "connecting", connecting: "connecting", reconnecting: "reconnecting", offline: "offline", error: "blocked" } as const
  )[connection.phase];
  return { ...base, phase, error: connection.error };
}

export const connection = new ShellConnection();
