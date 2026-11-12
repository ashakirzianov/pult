import { getService, INotificationService } from "@codingame/monaco-vscode-api";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import { type DesktopUpdateState, ServerSelfUpdateError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connection, environmentName } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import { confirmRestart } from "./updates.ts";

/** What the settings page shows of an environment's versions and its Pult.app's update. */
export interface EnvironmentVersions {
  /** Its server's, upstream's line (T3 Code's); null until its config is read. */
  readonly serverVersion: string | null;
  /** The update state of the desktop app on its machine, as its server relays it; null while none reports, or from a server without `desktopAppStatus`. */
  readonly desktop: DesktopUpdateState | null;
  /** While this page drives its update: its download and preparation, then the install. */
  readonly updating: "preparing" | "installing" | null;
}

const NONE: EnvironmentVersions = { serverVersion: null, desktop: null, updating: null };

/**
 * Every held environment's versions (`EnvironmentVersions`): its server config, followed as the
 * limits follow it, and, where the config advertises `desktopAppStatus` (Pult's servers), its
 * desktop app's update state (`server.subscribeDesktopApp`), resubscribed on each session, so a
 * remote Pult.app's row follows it across its restart. `install` updates a remote Pult.app, its
 * server preparing its app's update from the app's own feed, then committing it, which restarts
 * that app; this app's own update is the tray's (`updates.ts`).
 */
class EnvironmentVersionsModel {
  private readonly followed = new Map<
    string,
    {
      versions: EnvironmentVersions;
      readonly stopConfig: () => void;
      stopDesktop: (() => void) | undefined;
    }
  >();
  private readonly listeners = new Set<() => void>();

  readonly get = (environmentId: string): EnvironmentVersions =>
    this.followed.get(environmentId)?.versions ?? NONE;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    connection.onDidChange(() => this.sync());
    this.sync();
  }

  /** Updates a remote environment's Pult.app to the version its own updater found. */
  async install(environmentId: string): Promise<void> {
    const entry = this.followed.get(environmentId);
    const environment = connection.environment(environmentId);
    const version = entry?.versions.desktop?.availableVersion ?? null;
    if (entry === undefined || environment === undefined || version === null) return;
    if (entry.versions.updating !== null) return;
    const name = environmentName(environment, connection.environments);
    const consent = await confirmRestart(environmentId, name);
    if (consent === "cancelled") return;
    this.set(environmentId, { updating: "preparing" });
    try {
      // A desktop-managed server ignores the version unless it switches tracks; its app's feed decides.
      const prepared = await connection.run(
        environmentId,
        request(WS_METHODS.serverUpdateServer, { targetVersion: version }),
      );
      const token = prepared.desktopUpdateToken;
      if (token === undefined) throw new Error(`${name} prepared no desktop app update.`);
      // The download took a while; ask again if work started there meanwhile.
      if (consent === "at-rest" && (await confirmRestart(environmentId, name)) === "cancelled")
        return;
      this.set(environmentId, { updating: "installing" });
      await connection
        .run(environmentId, request(WS_METHODS.serverCommitDesktopUpdate, { requestId: token }))
        .catch((error: unknown) => {
          // The commit relaunches the app there, so a dropped socket is its success.
          if (error instanceof ServerSelfUpdateError) throw error;
        });
    } catch (error) {
      (await getService(INotificationService)).error(
        `Pult could not update ${name}. ${error instanceof ServerSelfUpdateError ? error.reason : error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.set(environmentId, { updating: null });
    }
  }

  private sync(): void {
    const held = new Set(connection.environments.map((environment) => environment.environmentId));
    for (const [environmentId, entry] of this.followed) {
      if (held.has(environmentId)) continue;
      entry.stopConfig();
      entry.stopDesktop?.();
      this.followed.delete(environmentId);
    }
    for (const environmentId of held) {
      if (this.followed.has(environmentId)) continue;
      const entry = {
        versions: NONE,
        stopDesktop: undefined as (() => void) | undefined,
        stopConfig: () => {},
      };
      this.followed.set(environmentId, entry);
      entry.stopConfig = followServerConfig(environmentId, (config) => {
        this.set(environmentId, { serverVersion: config.environment.serverVersion });
        if (config.desktopAppStatus !== true || entry.stopDesktop !== undefined) return;
        entry.stopDesktop = connection.follow(
          environmentId,
          subscribe(WS_METHODS.serverSubscribeDesktopApp, {}).pipe(
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                Effect.logError("[pult-shell] the desktop app's update state did not load", cause),
              ).pipe(Stream.drain),
            ),
          ),
          (desktop) => this.set(environmentId, { desktop }),
        );
      });
    }
    this.emit();
  }

  private set(environmentId: string, change: Partial<EnvironmentVersions>): void {
    const entry = this.followed.get(environmentId);
    if (entry === undefined) return;
    entry.versions = { ...entry.versions, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const environmentVersions = new EnvironmentVersionsModel();
