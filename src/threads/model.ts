import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { getInitialServerConfig } from "@t3tools/client-runtime/rpc";
import { type EnvironmentThreadShell, presentThreadShell } from "@t3tools/client-runtime/state/models";
import { type EnvironmentShellState, makeEnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { createInboxReturnTracker } from "@t3tools/client-runtime/state/thread-inbox";
import {
  isListedSettledThread,
  type OlderSettledShelfEnvironment,
  settledShelfFrontier,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, type OrchestrationV2ShellSnapshot, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection, environmentName } from "../connection/index.ts";
import { OlderSettledThreads } from "./olderSettled.ts";
import { type EnvironmentShell, nextWake, NO_THREAD_FEATURES, shellProject, shelfOf, shellThreads } from "./presentation.ts";
import { type ThreadFeatures, threadStore } from "./store.ts";

// The longest a wake waits between checks of the clock: a timer's clock stops while the machine sleeps, so a wake due
// during sleep would otherwise wait out its whole delay after it.
const WAKE_CHECK_MS = 60_000;

/** The shell state the model holds of an environment: its snapshot, its generation, and the threads removed since. */
interface HeldShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly generation: number;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}

/**
 * An environment the model follows: its last shell state, its threads presented (the older settled ones read in pages
 * among them), the features its server advertises, and what stops following it.
 */
interface Followed {
  held: (HeldShell & { threads: ReadonlyArray<EnvironmentThreadShell> }) | null;
  readonly olderSettled: OlderSettledThreads;
  features: ThreadFeatures | null;
  wasReady: boolean;
  readonly stop: () => void;
}

/**
 * An environment's shell state, as the registry's supervisor keeps it live;
 * undefined while it has no snapshot. Every change to the registry entry
 * restarts `followStream`, and so the shell state, empty until the snapshot
 * reloads.
 */
function followShellState(environmentId: EnvironmentId, publish: (state: HeldShell | undefined) => void) {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const held = (state: EnvironmentShellState) =>
      Option.match(state.snapshot, {
        onNone: () => undefined,
        onSome: (snapshot) => ({ snapshot, generation: state.generation, removedAt: state.removedAt }),
      });
    yield* registry
      .followStream(environmentId, Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))))
      .pipe(Stream.runForEach((state) => Effect.sync(() => publish(held(state)))));
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
 * working shelf ending (`inboxReturns`). The settled threads a shell leaves
 * out are counted, and read in pages while the Settled shelf shows more than
 * the model lists (`showSettled`, `olderSettled.ts`).
 */
class ThreadsModel {
  /** By environment id, as the connection holds them. */
  private readonly followed = new Map<string, Followed>();
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which threads work, held a moment after a run ends, as upstream's sidebar holds them on its working shelf. */
  private readonly inboxReturns = createInboxReturnTracker();
  /** How many settled threads the Settled shelf shows; none while it is collapsed. */
  private settledShown = 0;

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
      followed.olderSettled.dispose();
      this.followed.delete(environmentId);
    }
    for (const environment of environments) {
      const environmentId = environment.environmentId;
      let followed = this.followed.get(environmentId);
      if (followed === undefined) {
        const fiber = connection.runtime.runFork(
          followShellState(EnvironmentId.make(environmentId), (state) => this.follow(environmentId, state)),
        );
        followed = {
          held: null,
          olderSettled: new OlderSettledThreads(environmentId, () => this.present(environmentId)),
          features: null,
          wasReady: false,
          stop: () => void Effect.runFork(Fiber.interrupt(fiber)),
        };
        this.followed.set(environmentId, followed);
      }
      const ready = environment.phase === "ready";
      if (ready && !followed.wasReady) void this.loadFeatures(environmentId, followed);
      followed.wasReady = ready;
    }
    this.publish();
  }

  private follow(environmentId: string, state: HeldShell | undefined): void {
    const followed = this.followed.get(environmentId);
    if (followed === undefined || state === undefined || followed.held?.snapshot === state.snapshot) return;
    followed.held = { ...state, threads: [] };
    followed.olderSettled.follow(state.snapshot, state.generation, state.removedAt);
    this.present(environmentId);
  }

  /** Presents the environment's threads anew, the shell's and the older settled pages', and publishes them. */
  private present(environmentId: string): void {
    const followed = this.followed.get(environmentId);
    const held = followed?.held;
    if (followed === undefined || held == null) return;
    const id = EnvironmentId.make(environmentId);
    held.threads = [...held.snapshot.threads, ...followed.olderSettled.rows(held.snapshot, held.removedAt)].map((thread) =>
      presentThreadShell(id, thread),
    );
    this.publish();
  }

  /** The Settled shelf shows `count` threads, or none while collapsed: older settled pages are read until the model lists that many. */
  showSettled(count: number): void {
    if (count === this.settledShown) return;
    this.settledShown = count;
    this.publish();
  }

  /** Reads the older settled pages that failed again. */
  retrySettled(): void {
    for (const followed of this.followed.values()) followed.olderSettled.retry();
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
    const now = new Date().toISOString();
    const threads = shellThreads(loaded, now, this.inboxReturns.observe(loaded.flatMap((environment) => environment.threads)));
    const settled = this.settled(
      environments.map(({ followed }) => followed),
      now,
      threads.filter((thread) => thread.shelf === "settled").length,
    );
    threadStore.set({
      environments: environments.map(({ environment, followed }) => ({
        id: environment.environmentId,
        label: environment.label,
        name: environmentName(environment, connection.environments),
        phase: environment.phase,
        features: followed.features ?? NO_THREAD_FEATURES,
      })),
      threads,
      settled,
      projects: environments.flatMap(
        ({ environment, followed }) =>
          followed.held?.snapshot.projects.map((project) => shellProject(environment.environmentId, project)) ?? [],
      ),
    });
    this.scheduleWake(loaded.flatMap((environment) => environment.threads));
  }

  /**
   * The Settled shelf's count, the threads the shells leave out among them, as upstream's: the
   * listed ones and every environment's older ones not read yet; and the pages to read while
   * fewer threads are listed than the shelf shows (`wantedOlderSettledPages`), which reads them.
   */
  private settled(followed: ReadonlyArray<Followed>, now: string, listed: number) {
    const held = followed.flatMap(({ held, features, olderSettled }) =>
      held === null || features === null ? [] : [{ threads: held.threads, features, olderSettled }],
    );
    const threads = held.flatMap((environment) => environment.threads);
    const shelf = new Map(
      held.map(({ olderSettled }): [EnvironmentId, OlderSettledShelfEnvironment & { readonly read: () => void }] => [
        EnvironmentId.make(olderSettled.environmentId),
        { older: olderSettled.older, pages: olderSettled.pages, read: () => olderSettled.readPage() },
      ]),
    );
    const frontier = settledShelfFrontier([...shelf.values()]);
    const listedCount = held
      .flatMap(({ threads, features }) => threads.filter((thread) => shelfOf(thread, now, features) === "settled"))
      .filter((thread) => isListedSettledThread(thread.source, frontier)).length;
    const requested = new Map([...shelf].map(([id, environment]) => [id, environment.pages.reads.length] as const));
    const wanted = wantedOlderSettledPages({ requested, environments: shelf, listedCount, visibleCount: this.settledShown });
    if (wanted !== requested) {
      // Read after this publish, whose state the reads' own changes follow.
      queueMicrotask(() => {
        for (const [id, pages] of wanted) if (pages > (requested.get(id) ?? 0)) shelf.get(id)?.read();
      });
    }
    const unloaded = unloadedOlderSettledCount({
      olderSettled: (environmentId) => shelf.get(environmentId)?.older ?? null,
      scopes: [...shelf.keys()].map((environmentId) => ({ environmentId, projectIds: null })),
      threads,
    });
    const pages = [...shelf.values()].map((environment) => environment.pages.status);
    return { count: listed + unloaded, loading: pages.includes("pending"), failed: pages.includes("failed") };
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

/** The Settled shelf shows `count` threads, 0 while collapsed; the model reads the older ones its shells leave out as far as that. */
export function showSettledThreads(count: number): void {
  model.showSettled(count);
}

/** Reads again the older settled threads whose read failed. */
export function retrySettledThreads(): void {
  model.retrySettled();
}
