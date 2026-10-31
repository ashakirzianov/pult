import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { getInitialServerConfig } from "@t3tools/client-runtime/rpc";
import { type EnvironmentThreadShell, presentThreadShell } from "@t3tools/client-runtime/state/models";
import { makeEnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection, environmentName } from "../connection/index.ts";
import { type EnvironmentShell, nextWake, NO_THREAD_FEATURES, shellProject, shellThreads } from "./presentation.ts";
import { type ThreadFeatures, threadStore } from "./store.ts";

// The longest a wake waits between checks of the clock: a timer's clock stops while the machine sleeps, so a wake due
// during sleep would otherwise wait out its whole delay after it.
const WAKE_CHECK_MS = 60_000;

/** An environment the model follows: its last snapshot, presented, the features its server advertises, and what stops following it. */
interface Followed {
  held: { readonly snapshot: OrchestrationV2ShellSnapshot; readonly threads: ReadonlyArray<EnvironmentThreadShell> } | null;
  features: ThreadFeatures | null;
  wasReady: boolean;
  readonly stop: () => void;
}

/**
 * An environment's shell snapshot, as the registry's supervisor keeps it
 * live; undefined while the shell state has none. Every change to the
 * registry entry restarts `followStream`, and so the shell state, empty
 * until the snapshot reloads.
 */
function followShellSnapshot(environmentId: EnvironmentId, publish: (snapshot: OrchestrationV2ShellSnapshot | undefined) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry
      .followStream(environmentId, Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))))
      .pipe(Stream.runForEach((state) => Effect.sync(() => publish(Option.getOrUndefined(state.snapshot)))));
  });
}

/**
 * The page's thread model, after pult-extension's `ThreadsModel`: every held
 * environment's threads and projects from the shell snapshot its connection
 * keeps live, presented (`presentThreadShell`) and shelved across the
 * environments as upstream's sidebar does (`presentation.ts`), into
 * `threadStore`. Each environment's last snapshot is held through a
 * restarted shell state, and dropped with the environment. The thread
 * features each server advertises are read on each connect; an
 * environment's threads wait for them, so that none shows on the wrong shelf
 * first. A snooze ending is a change too, since it moves a thread off its
 * shelf and may show it Woke, and so is a thread's moment of grace on the
 * working shelf ending (`inboxReturns`).
 */
class ThreadsModel {
  /** By environment id, as the connection holds them. */
  private readonly followed = new Map<string, Followed>();
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which threads work, held a moment after a run ends, as upstream's sidebar holds them on its working shelf. */
  private readonly inboxReturns = createInboxReturnTracker();

  start(): void {
    this.inboxReturns.subscribe(() => this.publish());
    connection.onDidChange(() => this.followEnvironments());
    this.followEnvironments();
  }

  /** Follows every environment the connection holds and no other, reading each one's features as it becomes ready. */
  private followEnvironments(): void {
    const environments = connection.environments;
    for (const [environmentId, followed] of this.followed) {
      if (environments.some((environment) => environment.environmentId === environmentId)) continue;
      followed.stop();
      this.followed.delete(environmentId);
    }
    for (const environment of environments) {
      const environmentId = environment.environmentId;
      let followed = this.followed.get(environmentId);
      if (followed === undefined) {
        const fiber = connection.runtime.runFork(
          followShellSnapshot(EnvironmentId.make(environmentId), (snapshot) => this.follow(environmentId, snapshot)),
        );
        followed = { held: null, features: null, wasReady: false, stop: () => void Effect.runFork(Fiber.interrupt(fiber)) };
        this.followed.set(environmentId, followed);
      }
      const ready = environment.phase === "ready";
      if (ready && !followed.wasReady) void this.loadFeatures(environmentId, followed);
      followed.wasReady = ready;
    }
    this.publish();
  }

  private follow(environmentId: string, snapshot: OrchestrationV2ShellSnapshot | undefined): void {
    const followed = this.followed.get(environmentId);
    if (followed === undefined || snapshot === undefined || followed.held?.snapshot === snapshot) return;
    const id = EnvironmentId.make(environmentId);
    followed.held = { snapshot, threads: snapshot.threads.map((thread) => presentThreadShell(id, thread)) };
    this.publish();
  }

  private async loadFeatures(environmentId: string, followed: Followed): Promise<void> {
    const capabilities = await connection.run(environmentId, getInitialServerConfig()).then(
      (config) => config.environment.capabilities,
      (error: unknown) => {
        // Asked again on the connection's next change while it is ready.
        console.warn(`[pult-shell] could not read the server's thread features: ${String(error)}`);
        followed.wasReady = false;
        return null;
      },
    );
    if (capabilities === null || this.followed.get(environmentId) !== followed) return;
    followed.features = {
      settlement: capabilities.threadSettlement === true,
      snooze: capabilities.threadSnooze === true,
      pinning: capabilities.threadPinning === true,
    };
    this.publish();
  }

  /** Into the store: the environments as the connection stands, each one's projects, and its threads once its features are in. */
  private publish(): void {
    const environments = connection.environments.flatMap((environment) => {
      const followed = this.followed.get(environment.environmentId);
      return followed === undefined ? [] : [{ environment, followed }];
    });
    const loaded = environments.flatMap(({ environment, followed }): Array<EnvironmentShell> =>
      followed.held === null || followed.features === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              threads: followed.held.threads,
              projects: followed.held.snapshot.projects,
              features: followed.features,
            },
          ],
    );
    threadStore.set({
      environments: environments.map(({ environment, followed }) => ({
        id: environment.environmentId,
        label: environment.label,
        name: environmentName(environment, connection.environments),
        phase: environment.phase,
        features: followed.features ?? NO_THREAD_FEATURES,
      })),
      threads: shellThreads(
        loaded,
        new Date().toISOString(),
        this.inboxReturns.observe(loaded.flatMap((environment) => environment.threads)),
      ),
      projects: environments.flatMap(
        ({ environment, followed }) =>
          followed.held?.snapshot.projects.map((project) => shellProject(environment.environmentId, project)) ?? [],
      ),
    });
    this.scheduleWake(loaded.flatMap((environment) => environment.threads));
  }

  private scheduleWake(threads: ReadonlyArray<EnvironmentThreadShell>): void {
    clearTimeout(this.wakeTimer);
    const wake = nextWake(threads, Date.now());
    if (wake === null) return;
    const check = () => {
      if (Date.now() >= wake) this.publish();
      else this.wakeTimer = setTimeout(check, Math.min(wake - Date.now() + 1, WAKE_CHECK_MS));
    };
    check();
  }
}

const model = new ThreadsModel();

/** Starts the thread model on the page's connection; before the workbench, as the connection is. */
export function startThreadModel(): void {
  model.start();
}
