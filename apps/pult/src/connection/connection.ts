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
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import {
  type ResolvedRemotePairingTarget,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { desktopHost } from "../desktop/host.ts";
import { platformLayer } from "./platform.ts";
import { probe } from "./probe.ts";

export type ConnectionPhase = "connecting" | "ready" | "reconnecting" | "offline" | "blocked";

/** An environment the page holds, as its connection stands: what the shell and the thread view see. */
export interface ShellEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly phase: ConnectionPhase;
  /** Why the connection is not ready and, when only the user can fix it, how. */
  readonly error: string | null;
}

/**
 * How the shell tells `environment` apart from the others it holds: its
 * label, or where another shares the label (two servers on one machine), the
 * host its server answers on.
 */
export function environmentName(
  environment: ShellEnvironment,
  environments: ReadonlyArray<ShellEnvironment>,
): string {
  const shared = environments.some(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  return shared && URL.canParse(environment.httpBaseUrl)
    ? new URL(environment.httpBaseUrl).host
    : environment.label;
}

/**
 * What the page's sessions subscribe to of each server's config: the
 * environment's themes, the usage limit hubs and the /usage-limits command.
 * A follow of the config (`src/limits/model.ts`) passes these same options,
 * since a session replays its own subscription only on an equal input and
 * opens a second one on the socket otherwise.
 */
export const SERVER_CONFIG_OPTIONS = {
  environmentThemes: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
} as const;

/** An environment the page connects to after a reload, with its bearer, in the workbench's secret storage. */
const Saved = Schema.Struct({ profile: BearerConnectionProfile, token: Schema.String });
type Saved = typeof Saved.Type;
/** The saved set, in the order its environments were connected. */
const SAVED_KEY = "pult-shell.environments";
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Saved)));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Saved)));
/** The one environment a page saved before it held several, read once into the set. */
const SINGLE_SAVED_KEY = "pult-shell.environment";
/** In Pult.app, the environment id of the app's own server, which a start with the local server off does not reconnect. */
const LOCAL_KEY = "pult-shell.localEnvironment";
const decodeSingleSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved));

/**
 * The runtime's registration of a held environment. In Pult.app the app's own
 * server is the runtime's primary environment, as upstream's desktop page
 * registers it, its bearer read from the app at each connect
 * (`PrimaryEnvironmentAuth`, `platform.ts`): the view keys what belongs to
 * this machine on it, the native preview webviews among them
 * (`pult/decisions`, `primary-environment`). Every other environment is a
 * bearer registration.
 */
function registration(saved: Saved, primary: boolean): PlatformConnectionRegistration {
  const { profile, token } = saved;
  if (primary) {
    return new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: profile.environmentId,
        label: profile.label,
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
      }),
    });
  }
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

/** An environment the page holds: its bearer, its registration, its state as the registry last published it, and what stops following that state. */
interface Held {
  saved: Saved;
  registration: PlatformConnectionRegistration;
  state: ShellEnvironment | null;
  stop: () => void;
}

/**
 * The page's connections to its environments (`pult/decisions`,
 * `connection-owner`): the client runtime, with every environment the
 * shell connects as a platform registration, so the registry's supervisors
 * dial one socket per environment and reconnect it. The thread view runs on
 * this runtime's services (`context`), the thread model follows each
 * environment's shell snapshot and the thread commands run their RPCs on the
 * thread's environment (`run`).
 */
class ShellConnection {
  private readonly registrations = Effect.runSync(
    SubscriptionRef.make<ReadonlyArray<PlatformConnectionRegistration>>([]),
  );
  /** By environment id, in the order they were connected. */
  private readonly held = new Map<EnvironmentId, Held>();
  /** In Pult.app with its local server on, the environment id of the app's own server, held as the primary environment. */
  private local: EnvironmentId | undefined;
  /** Until `restore` settles, the page may yet connect to the environments saved before the reload. */
  private restoring = true;
  private list: ReadonlyArray<ShellEnvironment> = [];
  private readonly listeners = new Set<() => void>();
  readonly runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Connection.layerWithOptions(SERVER_CONFIG_OPTIONS),
      // The shell snapshot's HTTP load, for the thread model (`src/threads/model.ts`).
      ShellSnapshotLoader.layer,
    ).pipe(Layer.provideMerge(platformLayer(SubscriptionRef.changes(this.registrations)))),
  );

  /**
   * Every environment the page holds, in the order they were connected, as
   * its connection stands; one the registry has not published yet reads
   * `connecting`. The same array until the next change.
   */
  get environments(): ReadonlyArray<ShellEnvironment> {
    return this.list;
  }

  /** In Pult.app with its local server on, the app's own server as its connection stands. */
  get localEnvironment(): ShellEnvironment | undefined {
    return this.local === undefined ? undefined : this.environment(this.local);
  }

  /** The held environment `environmentId` names, in any case, as a `pult:` authority may. */
  environment(environmentId: string): ShellEnvironment | undefined {
    const wanted = environmentId.toLowerCase();
    return this.list.find((environment) => environment.environmentId.toLowerCase() === wanted);
  }

  /**
   * An environment's bearer and the server it belongs to, for requests the
   * page sends outside the runtime (an asset's bytes, `src/files/server.ts`):
   * held together, so the bearer never goes to a server it is not for.
   */
  credential(environmentId: string) {
    const saved = this.heldOf(environmentId)?.saved;
    return (
      saved && {
        label: saved.profile.label,
        httpBaseUrl: saved.profile.httpBaseUrl,
        token: saved.token,
      }
    );
  }

  /** Whether the page is about to connect without the user: it is restoring the environments saved before the reload. */
  get connecting(): boolean {
    return this.restoring;
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs an effect on the environment's supervisor: RPCs go to its live
   * session, and fail with `EnvironmentRpcUnavailableError` while there is
   * none or the page does not hold the environment.
   */
  run<A, E>(
    environmentId: string,
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
  ): Promise<A> {
    const id = this.heldOf(environmentId)?.saved.profile.environmentId;
    if (id === undefined) {
      return Promise.reject(
        new EnvironmentRpcUnavailableError({
          environmentId,
          message: "Pult is not connected to this environment.",
        }),
      );
    }
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.run(id, effect)),
      ),
    );
  }

  /**
   * Runs a stream on the environment's supervisor, handing each item to
   * `onItem`, until the returned function stops it or the page lets the
   * environment go.
   */
  follow<A>(
    environmentId: string,
    stream: Stream.Stream<A, never, EnvironmentSupervisor.EnvironmentSupervisor>,
    onItem: (item: A) => void,
  ): () => void {
    const id = this.heldOf(environmentId)?.saved.profile.environmentId;
    if (id === undefined) return () => {};
    const fiber = this.runtime.runFork(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry
            .followStream(id, stream)
            .pipe(Stream.runForEach((item) => Effect.sync(() => onItem(item)))),
        ),
      ),
    );
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }

  /** The runtime's services, for the thread view's state runtime. */
  context() {
    return this.runtime.context();
  }

  /** Connects the environments saved before the reload, if any. Called once the workbench is up. */
  async restore(): Promise<void> {
    try {
      const secrets = await getService(ISecretStorageService);
      let saved = Option.getOrUndefined(decodeSaved(await secrets.get(SAVED_KEY)));
      if (saved === undefined) {
        const single = Option.getOrUndefined(
          decodeSingleSaved(await secrets.get(SINGLE_SAVED_KEY)),
        );
        saved = single === undefined ? [] : [single];
        if (single !== undefined) {
          await secrets.set(SAVED_KEY, encodeSaved(saved));
          await secrets.delete(SINGLE_SAVED_KEY);
        }
      }
      const bridge = desktopHost();
      const local = bridge === undefined ? undefined : await secrets.get(LOCAL_KEY);
      const localOn = bridge?.getLocalEnvironmentEnabled() === true;
      // On, the app's own server is restored as the primary; off, it is not reconnected.
      const savedLocal = saved.find((each) => each.profile.environmentId === local);
      if (localOn) this.local = savedLocal?.profile.environmentId;
      for (const each of saved) {
        if (!localOn && each.profile.environmentId === local) continue;
        this.hold(each);
      }
      if (!localOn && local !== undefined && saved.length !== this.held.size) await this.persist();
      await this.register();
      await this.connectLocal().catch((error: unknown) =>
        console.warn("[pult-shell] could not connect the desktop's own server:", error),
      );
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  /**
   * In Pult.app (`desktopHost`), connects the server the app supervises, with
   * the bearer the app hands the page: no pairing link (`pult/decisions`,
   * `local-server`). Nothing when the app runs no local server.
   */
  private async connectLocal(): Promise<void> {
    const bridge = desktopHost();
    if (bridge === undefined || !bridge.getLocalEnvironmentEnabled()) return;
    const primary = bridge
      .getLocalEnvironmentBootstraps()
      .find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (!primary?.httpBaseUrl) return;
    const token = await bridge.getLocalEnvironmentBearerToken();
    const target = resolveRemotePairingTarget({ host: primary.httpBaseUrl, pairingCode: token });
    const environmentId = await this.connect(
      primary.wsBaseUrl ? { ...target, wsBaseUrl: primary.wsBaseUrl } : target,
      { local: true },
    );
    await (await getService(ISecretStorageService)).set(LOCAL_KEY, environmentId);
  }

  /**
   * Probes the target from the page, whose origin the server sees, and only if
   * it answers saves it and connects it beside the environments the page
   * holds; an environment held already takes the new bearer. `local` marks the
   * app's own server, which is held as the primary environment. Answers its
   * environment id; fails with the probe's `ProbeError`.
   */
  async connect(
    target: ResolvedRemotePairingTarget,
    options?: { readonly local?: boolean },
  ): Promise<EnvironmentId> {
    const probed = await this.runtime.runPromise(probe({ target, origin: window.location.origin }));
    const saved = { profile: probed.profile, token: probed.credential.token };
    const environmentId = saved.profile.environmentId;
    if (options?.local === true && this.local !== environmentId) {
      // A previous local server still held, whose id the app's server no longer serves, is a bearer environment now.
      const previous = this.local === undefined ? undefined : this.held.get(this.local);
      this.local = environmentId;
      if (previous !== undefined) previous.registration = registration(previous.saved, false);
    }
    const held = this.held.get(environmentId);
    const next = registration(saved, this.isLocal(saved));
    if (
      held !== undefined &&
      held.registration._tag === "PrimaryConnectionRegistration" &&
      next._tag === "PrimaryConnectionRegistration"
    ) {
      // The primary's registration carries no bearer: the same server keeps its socket, and at a new address it is swapped in place, so the primary never goes away meanwhile.
      const unchanged = samePrimary(held.registration, next);
      held.saved = saved;
      held.registration = next;
      await this.persist();
      await this.register();
      // A restore registers it before the app's server answers, so its first attempt may be backing off while the probe just succeeded.
      if (unchanged && held.state?.phase !== "ready") await this.retryNow(environmentId);
      return environmentId;
    }
    // A new bearer for the same environment needs a new registration, so the old one goes first.
    if (held !== undefined) {
      this.release(environmentId);
      await this.register();
    }
    this.hold(saved);
    await this.persist();
    await this.register();
    return environmentId;
  }

  /** Closes the environment's connection and forgets it with its bearer; the others stay. */
  async disconnect(environmentId: string): Promise<void> {
    const id = this.heldOf(environmentId)?.saved.profile.environmentId;
    if (id === undefined) return;
    this.release(id);
    await this.persist();
    await this.register();
  }

  /** Retries an environment's connection waiting between attempts. */
  retryNow(environmentId: string): Promise<void> {
    const id = this.heldOf(environmentId)?.saved.profile.environmentId;
    if (id === undefined) return Promise.resolve();
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(id)),
      ),
    );
  }

  private isLocal(saved: Saved): boolean {
    return this.local !== undefined && saved.profile.environmentId === this.local;
  }

  private heldOf(environmentId: string): Held | undefined {
    const wanted = environmentId.toLowerCase();
    for (const [id, held] of this.held) if (id.toLowerCase() === wanted) return held;
    return undefined;
  }

  /** Holds the environment, following its state as the registry publishes it; registered by the next `register`. */
  private hold(saved: Saved): void {
    const environmentId = saved.profile.environmentId;
    const held: Held = {
      saved,
      registration: registration(saved, this.isLocal(saved)),
      state: null,
      stop: () => {},
    };
    this.held.set(environmentId, held);
    const fiber = this.runtime.runFork(
      followEnvironment(environmentId, (next) => {
        if (this.held.get(environmentId) !== held) return;
        held.state = next;
        this.changed();
      }),
    );
    held.stop = () => void Effect.runFork(Fiber.interrupt(fiber));
    this.changed();
  }

  private release(environmentId: EnvironmentId): void {
    const held = this.held.get(environmentId);
    if (held === undefined) return;
    held.stop();
    this.held.delete(environmentId);
    this.changed();
  }

  /** The held set as the runtime's platform registrations; an environment kept keeps its registration, and so its socket. */
  private register(): Promise<void> {
    const registrations = [...this.held.values()].map((held) => held.registration);
    return this.runtime.runPromise(SubscriptionRef.set(this.registrations, registrations));
  }

  private async persist(): Promise<void> {
    const secrets = await getService(ISecretStorageService);
    await secrets.set(SAVED_KEY, encodeSaved([...this.held.values()].map((held) => held.saved)));
  }

  private changed(): void {
    this.list = [...this.held.values()].map((held) => held.state ?? pending(held.saved));
    for (const listener of this.listeners) listener();
  }
}

/** Whether both are the primary registration of one environment at one address, which a new bearer leaves as it is. */
function samePrimary(
  held: PlatformConnectionRegistration,
  next: PlatformConnectionRegistration,
): boolean {
  if (held._tag !== "PrimaryConnectionRegistration") return false;
  if (next._tag !== "PrimaryConnectionRegistration") return false;
  const [a, b] = [held.target, next.target];
  return (
    a.environmentId === b.environmentId &&
    a.label === b.label &&
    a.httpBaseUrl === b.httpBaseUrl &&
    a.wsBaseUrl === b.wsBaseUrl
  );
}

/** A held environment the registry has not published yet. */
function pending({ profile }: Saved): ShellEnvironment {
  return {
    environmentId: profile.environmentId,
    label: profile.label,
    httpBaseUrl: profile.httpBaseUrl,
    wsBaseUrl: profile.wsBaseUrl,
    phase: "connecting",
    error: null,
  };
}

/** The environment as its registry entry and supervisor stand, while it is registered. */
const followEnvironment = Effect.fn("Pult.followEnvironment")(function* (
  environmentId: EnvironmentId,
  publish: (next: ShellEnvironment) => void,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry
    .followStream(
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
    )
    .pipe(Stream.runForEach((next) => Effect.sync(() => publish(next))));
});

function present(
  entry: ConnectionCatalogEntry,
  state: SupervisorConnectionState,
): ShellEnvironment {
  // The primary's target carries its address; a bearer environment's profile does.
  const address =
    entry.target._tag === "PrimaryConnectionTarget"
      ? entry.target
      : Option.getOrUndefined(Option.filter(entry.profile, Schema.is(BearerConnectionProfile)));
  const base = {
    environmentId: entry.target.environmentId,
    label: entry.target.label,
    httpBaseUrl: address?.httpBaseUrl ?? "",
    wsBaseUrl: address?.wsBaseUrl ?? "",
  };
  const connection = presentConnectionState(state);
  // An unsupported server blocks the supervisor; the registry then switches
  // the entry off and keeps the verdict there (pult-extension's `presentation.ts`).
  if (!entry.enabled || connection.phase === "unsupported") {
    const reason =
      entry.unsupportedReason ??
      connection.error ??
      `${entry.target.label} does not support this Pult.`;
    return {
      ...base,
      phase: "blocked",
      error: `${reason} Disconnect, then connect again after the update.`,
    };
  }
  const phase = (
    {
      connected: "ready",
      available: "connecting",
      connecting: "connecting",
      reconnecting: "reconnecting",
      offline: "offline",
      error: "blocked",
    } as const
  )[connection.phase];
  return { ...base, phase, error: connection.error };
}

export const connection = new ShellConnection();
