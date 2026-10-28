import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { getInitialServerConfig } from "@t3tools/client-runtime/rpc";
import { type EnvironmentThreadShell, presentThreadShell } from "@t3tools/client-runtime/state/models";
import { makeEnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection } from "../connection/index.ts";
import { nextWake, NO_THREAD_FEATURES, shellProject, shellThreads } from "./presentation.ts";
import { type ThreadFeatures, threadStore } from "./store.ts";

// The longest delay `setTimeout` keeps; a later wake is waited for in steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Held {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

/** The environment followed, null for none, and its snapshot, undefined while it has none yet. */
type Followed = readonly [EnvironmentId | null, OrchestrationV2ShellSnapshot | undefined];

/**
 * The connected environment's shell snapshot, as the registry's supervisor
 * keeps it live. Every change to the registry entry restarts `followStream`,
 * and so the shell state, empty until the snapshot reloads.
 */
function followShellSnapshot(publish: (...followed: Followed) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Option.fromUndefinedOr(entries.keys().next().value)),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.succeed<Followed>([null, undefined]),
          onSome: (environmentId) =>
            registry
              .followStream(environmentId, Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))))
              .pipe(Stream.map((state): Followed => [environmentId, Option.getOrUndefined(state.snapshot)])),
        }),
      ),
      Stream.runForEach(([environmentId, snapshot]) => Effect.sync(() => publish(environmentId, snapshot))),
    );
  });
}

/**
 * The page's thread model, after pult-extension's `ThreadsModel`: the
 * connected environment's threads and projects from the shell snapshot the
 * page's connection keeps live, presented (`presentThreadShell`) and shelved
 * as upstream's sidebar does (`presentation.ts`), into `threadStore`. The last
 * snapshot is held through a restarted shell state, and dropped when the
 * environment changes. The thread features its server advertises are read on
 * each connect; the threads wait for them, so that none shows on the wrong
 * shelf first. A snooze ending is a change too, since it moves a thread off
 * its shelf and may show it Woke.
 */
class ThreadsModel {
  private held: Held | null = null;
  private featureSet: { readonly environmentId: string; readonly features: ThreadFeatures } | null = null;
  private wasReady = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    connection.onDidChange(() => this.followEnvironment());
    connection.runtime.runFork(followShellSnapshot((environmentId, snapshot) => this.follow(environmentId, snapshot)));
    this.followEnvironment();
  }

  private followEnvironment(): void {
    const environment = connection.environment;
    const ready = environment?.phase === "ready";
    if (ready && !this.wasReady) void this.loadFeatures(environment.environmentId);
    this.wasReady = ready;
    if (this.featureSet !== null && this.featureSet.environmentId !== environment?.environmentId) this.featureSet = null;
    this.publish();
  }

  private follow(environmentId: EnvironmentId | null, snapshot: OrchestrationV2ShellSnapshot | undefined): void {
    if (environmentId === null) {
      if (this.held === null) return;
      this.held = null;
    } else if (snapshot !== undefined) {
      if (this.held?.snapshot === snapshot) return;
      this.held = { environmentId, snapshot, threads: snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)) };
    } else if (this.held !== null && this.held.environmentId !== environmentId) {
      this.held = null;
    } else return;
    this.publish();
  }

  private async loadFeatures(environmentId: string): Promise<void> {
    const capabilities = await connection.run(getInitialServerConfig()).then(
      (config) => config.environment.capabilities,
      (error: unknown) => {
        // Asked again on the connection's next change while it is ready.
        console.warn(`[pult-shell] could not read the server's thread features: ${String(error)}`);
        this.wasReady = false;
        return null;
      },
    );
    if (capabilities === null || connection.environment?.environmentId !== environmentId) return;
    this.featureSet = {
      environmentId,
      features: {
        settlement: capabilities.threadSettlement === true,
        snooze: capabilities.threadSnooze === true,
        pinning: capabilities.threadPinning === true,
      },
    };
    this.publish();
  }

  /** Into the store: the environment as the connection stands, and its threads once the features are in. */
  private publish(): void {
    const environment = connection.environment;
    const features =
      this.featureSet !== null && this.featureSet.environmentId === environment?.environmentId
        ? this.featureSet.features
        : null;
    const held = this.held !== null && this.held.environmentId === environment?.environmentId ? this.held : null;
    const loaded = held !== null && features !== null;
    threadStore.set({
      environment:
        environment === null ? null : { id: environment.environmentId, label: environment.label, phase: environment.phase },
      features: features ?? NO_THREAD_FEATURES,
      threads: loaded ? shellThreads(held.threads, held.snapshot.projects, new Date().toISOString(), features) : [],
      projects: held?.snapshot.projects.map(shellProject) ?? [],
    });
    this.scheduleWake(loaded ? held.threads : []);
  }

  private scheduleWake(threads: ReadonlyArray<EnvironmentThreadShell>): void {
    clearTimeout(this.wakeTimer);
    const wake = nextWake(threads, Date.now());
    if (wake === null) return;
    this.wakeTimer = setTimeout(() => this.publish(), Math.min(wake - Date.now() + 1, MAX_TIMER_MS));
  }
}

const model = new ThreadsModel();

/** Starts the thread model on the page's connection; before the workbench, as the connection is. */
export function startThreadModel(): void {
  model.start();
}
