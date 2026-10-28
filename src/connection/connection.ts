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
import type { EnvironmentId } from "@t3tools/contracts";
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
export function environmentName(environment: ShellEnvironment, environments: ReadonlyArray<ShellEnvironment>): string {
  const shared = environments.some((other) => other.environmentId !== environment.environmentId && other.label === environment.label);
  return shared && URL.canParse(environment.httpBaseUrl) ? new URL(environment.httpBaseUrl).host : environment.label;
}

/** An environment the page connects to after a reload, with its bearer, in the workbench's secret storage. */
const Saved = Schema.Struct({ profile: BearerConnectionProfile, token: Schema.String });
type Saved = typeof Saved.Type;
/** The saved set, in the order its environments were connected. */
const SAVED_KEY = "pult-shell.environments";
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Saved)));
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Saved)));
/** The one environment a page saved before it held several, read once into the set. */
const SINGLE_SAVED_KEY = "pult-shell.environment";
const decodeSingleSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved));

function registration(saved: Saved): BearerConnectionRegistration {
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

/** An environment the page holds: its bearer, its registration, its state as the registry last published it, and what stops following that state. */
interface Held {
  readonly saved: Saved;
  readonly registration: BearerConnectionRegistration;
  state: ShellEnvironment | null;
  stop: () => void;
}

/**
 * The page's connections to its environments (`pult/decisions`,
 * `connection-owner`): the vendored runtime, with every environment the
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
  /** Until `restore` settles, the page may yet connect to the environments saved before the reload. */
  private restoring = true;
  private list: ReadonlyArray<ShellEnvironment> = [];
  private readonly listeners = new Set<() => void>();
  readonly runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Connection.layerWithOptions({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true }),
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
    return saved && { label: saved.profile.label, httpBaseUrl: saved.profile.httpBaseUrl, token: saved.token };
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
  run<A, E>(environmentId: string, effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>): Promise<A> {
    const id = this.heldOf(environmentId)?.saved.profile.environmentId;
    if (id === undefined) {
      return Promise.reject(new EnvironmentRpcUnavailableError({ environmentId, message: "Pult is not connected to this environment." }));
    }
    return this.runtime.runPromise(
      EnvironmentRegistry.EnvironmentRegistry.pipe(Effect.flatMap((registry) => registry.run(id, effect))),
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
          registry.followStream(id, stream).pipe(Stream.runForEach((item) => Effect.sync(() => onItem(item)))),
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
        const single = Option.getOrUndefined(decodeSingleSaved(await secrets.get(SINGLE_SAVED_KEY)));
        saved = single === undefined ? [] : [single];
        if (single !== undefined) {
          await secrets.set(SAVED_KEY, encodeSaved(saved));
          await secrets.delete(SINGLE_SAVED_KEY);
        }
      }
      for (const each of saved) this.hold(each);
      await this.register();
    } finally {
      this.restoring = false;
      this.changed();
    }
  }

  /**
   * Probes the target from the page, whose origin the server sees, and only if
   * it answers saves it and connects it beside the environments the page
   * holds; an environment held already takes the new bearer. Fails with the
   * probe's `ProbeError`.
   */
  async connect(target: ResolvedRemotePairingTarget): Promise<void> {
    const probed = await this.runtime.runPromise(probe({ target, origin: window.location.origin }));
    const saved = { profile: probed.profile, token: probed.credential.token };
    // A new bearer for the same environment needs a new registration, so the old one goes first.
    if (this.held.has(saved.profile.environmentId)) {
      this.release(saved.profile.environmentId);
      await this.register();
    }
    this.hold(saved);
    await this.persist();
    await this.register();
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
      EnvironmentRegistry.EnvironmentRegistry.pipe(Effect.flatMap((registry) => registry.retryNow(id))),
    );
  }

  private heldOf(environmentId: string): Held | undefined {
    const wanted = environmentId.toLowerCase();
    for (const [id, held] of this.held) if (id.toLowerCase() === wanted) return held;
    return undefined;
  }

  /** Holds the environment, following its state as the registry publishes it; registered by the next `register`. */
  private hold(saved: Saved): void {
    const environmentId = saved.profile.environmentId;
    const held: Held = { saved, registration: registration(saved), state: null, stop: () => {} };
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
function followEnvironment(environmentId: EnvironmentId, publish: (next: ShellEnvironment) => void) {
  return Effect.gen(function* () {
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
