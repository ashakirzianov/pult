import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { makeEnvironmentServerConfigState } from "@t3tools/client-runtime/state/server";
import { EnvironmentId, type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitNotices, type LimitAccount, type LimitPresentations } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection, environmentName, SERVER_CONFIG_OPTIONS } from "../connection/index.ts";

/** What the Limits shelf reads: the accounts merged across the environments, when each environment's limits were last checked, and the notices. */
export interface LimitsState {
  readonly accounts: ReadonlyArray<LimitAccount>;
  /** Per held environment, in the connection's order: its name and its freshest check, null before any. */
  readonly checks: ReadonlyArray<{ readonly environmentId: string; readonly name: string; readonly checkedAt: string | null }>;
  /** A failed probe, a hub with no accounts (`collectLimitNotices`). */
  readonly notices: ReadonlyArray<string>;
  /** Whether a refresh asked of the servers is under way. */
  readonly refreshing: boolean;
}

/**
 * An environment's server config, as the registry's supervisor keeps it
 * live, on the same subscription the session holds (`SERVER_CONFIG_OPTIONS`),
 * which it replays rather than opening another. Every change to the registry
 * entry restarts `followStream`, and so the config's state, empty until the
 * session replays it; the page's cache store keeps nothing to start it from.
 */
function followServerConfig(environmentId: EnvironmentId, publish: (config: ServerConfig) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry
      .followStream(environmentId, Stream.unwrap(makeEnvironmentServerConfigState(SERVER_CONFIG_OPTIONS).pipe(Effect.map(SubscriptionRef.changes))))
      .pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            if (Option.isSome(state)) publish(state.value.config);
          }),
        ),
      );
  });
}

/** The freshest of a config's checks: its providers' limits and its hubs'. */
function latestCheck(config: ServerConfig | null): string | null {
  const checks = [
    ...(config?.providers ?? []).flatMap((provider) => (provider.usageLimits === undefined ? [] : [provider.usageLimits.checkedAt])),
    ...(config?.usageLimitSources ?? []).map((source) => source.checkedAt),
  ];
  return checks.reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null);
}

/**
 * The page's usage limits (xaxis `pult/issues/provider-limits-page`): every
 * held environment's provider snapshots and hub sources from the server
 * config its session keeps live, merged into accounts across the
 * environments as upstream merges them (`collectLimitAccounts`), into
 * `limitsStore`. Each environment's last config is held through a restarted
 * follow, an environment not ready keeping its last values, and dropped
 * with the environment.
 */
class LimitsModel {
  /** By environment id, as the connection holds them. */
  private readonly followed = new Map<string, { config: ServerConfig | null; readonly stop: () => void }>();
  private state: LimitsState = { accounts: [], checks: [], notices: [], refreshing: false };
  private readonly listeners = new Set<() => void>();

  readonly get = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  start(): void {
    connection.onDidChange(() => this.followEnvironments());
    this.followEnvironments();
  }

  private followEnvironments(): void {
    const environments = connection.environments;
    for (const [environmentId, followed] of this.followed) {
      if (environments.some((environment) => environment.environmentId === environmentId)) continue;
      followed.stop();
      this.followed.delete(environmentId);
    }
    for (const { environmentId } of environments) {
      if (this.followed.has(environmentId)) continue;
      const followed = { config: null as ServerConfig | null, stop: () => {} };
      const fiber = connection.runtime.runFork(
        followServerConfig(EnvironmentId.make(environmentId), (config) => {
          if (followed.config === config) return;
          followed.config = config;
          this.publish();
        }),
      );
      followed.stop = () => void Effect.runFork(Fiber.interrupt(fiber));
      this.followed.set(environmentId, followed);
    }
    this.publish();
  }

  private publish(refreshing = this.state.refreshing): void {
    const environments = connection.environments;
    const held = environments.flatMap((environment) => {
      const followed = this.followed.get(environment.environmentId);
      return followed === undefined ? [] : [{ environment, name: environmentName(environment, environments), config: followed.config }];
    });
    const presentations: LimitPresentations = new Map(
      held.map(({ environment, name, config }) => [EnvironmentId.make(environment.environmentId), { entry: { target: { label: name } }, serverConfig: config }]),
    );
    this.state = {
      accounts: collectLimitAccounts(presentations),
      checks: held.map(({ environment, name, config }) => ({ environmentId: environment.environmentId, name, checkedAt: latestCheck(config) })),
      notices: collectLimitNotices(presentations),
      refreshing,
    };
    for (const listener of this.listeners) listener();
  }

  /** Asks every ready environment's server to read its providers' limits again, hubs included; the new limits come on the config stream. */
  async refresh(): Promise<void> {
    if (this.state.refreshing) return;
    const ready = connection.environments.filter((environment) => environment.phase === "ready");
    if (ready.length === 0) return;
    this.publish(true);
    const results = await Promise.allSettled(
      ready.map((environment) =>
        connection.run(
          environment.environmentId,
          // As upstream's `refreshProviders` command sends it, on a session subscribed with the /usage-limits command.
          request(WS_METHODS.serverRefreshProviders, { workspaceSnapshotsOnDemand: true, usageLimitsCommand: true }),
        ),
      ),
    );
    this.publish(false);
    const failed = results.flatMap((result, index) => (result.status === "rejected" ? [{ environment: ready[index]!, error: result.reason }] : []));
    if (failed.length === 0) return;
    const notifications = await getService(INotificationService);
    for (const { environment, error } of failed) {
      notifications.warn(`Pult could not refresh the usage limits of ${environmentName(environment, connection.environments)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const model = new LimitsModel();

/** The usage limits, for `useSyncExternalStore`. */
export const limitsStore = { get: model.get, subscribe: model.subscribe };

/** Starts the limits model on the page's connection; before the workbench, as the thread model is. */
export function startLimitsModel(): void {
  model.start();
}

export function refreshLimits(): Promise<void> {
  return model.refresh();
}
