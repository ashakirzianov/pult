import type { ProjectIconOverride } from "@t3tools/contracts";

/** Upstream's sidebar shelves, in its order; the model puts every listed thread on one. */
export type ShelfName = "pinned" | "active" | "working" | "snoozed" | "settled";

/** A thread as the panel and the pane show it: the fields of its `EnvironmentThreadShell` they read (`shellThreads` in `presentation.ts`). */
export interface ShellThread {
  /** Its environment: thread ids are unique only within one. */
  readonly environmentId: string;
  readonly id: string;
  /** Its shelf; null for a subagent, which the panel lists under its root's card. */
  readonly shelf: ShelfName | null;
  /** The thread that spawned or forked it, in the same environment; null for a thread of its own. */
  readonly parentId: string | null;
  /** The top of its lineage, itself for a thread of its own. */
  readonly rootId: string;
  readonly projectId: string;
  readonly projectName: string;
  /** The project's root on the environment host, for `pult:` URIs. */
  readonly projectRoot: string | null;
  /** The project's chosen icon; null for its favicon or the one upstream derives from its name. */
  readonly projectIcon: ProjectIconOverride | null;
  /** The project's chosen favicon file, relative to its root; null for the one the server finds. */
  readonly projectFaviconPath: string | null;
  readonly title: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** What its card's age counts from, as upstream's row: a settled thread's settlement, else its latest message from the user, else its last change. */
  readonly ageFrom: string | null;
  /** Woke from a snooze and not visited since (upstream's Woke). */
  readonly woke: boolean;
  /** In motion: working, or waiting on background work that will wake it. */
  readonly working: boolean;
  /** Upstream's Waiting: stopped, its run held open by background work, such as subagents, that will wake it. */
  readonly waiting: boolean;
  /** When its current work started, while it works and the server knows. */
  readonly workingSince: string | null;
  readonly pinned: boolean;
  /** Whether it may be snoozed now, as of the model's last change: no pending approval or input, no queued turn start. */
  readonly canSnooze: boolean;
  readonly latestRun: { status: string; startedAt: string | null; finishedAt: string | null } | null;
  readonly goal: string | null;
}

/** What a thread's server lets a client do to it; each off until it says. */
export interface ThreadFeatures {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
}

/** An environment the page holds, as the cards and the thread's place name it. */
export interface ShellEnvironment {
  readonly id: string;
  readonly label: string;
  /** What tells it apart from the other environments held (`environmentName`): its label, or its server's host where another shares the label. */
  readonly name: string;
  readonly phase: string;
  /** What its server lets a client do to a thread. */
  readonly features: ThreadFeatures;
}

/** A project of an environment, threads or none: what a new thread's draft shows of it. */
export interface ShellProject {
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  /** Its root on the environment host, for `pult:` URIs; null when only a thread's word on it, without one, is known. */
  readonly root: string | null;
  /** Its chosen icon; null for its favicon or the one upstream derives from its name. */
  readonly icon: ProjectIconOverride | null;
  /** Its chosen favicon file, relative to its root; null for the one the server finds. */
  readonly faviconPath: string | null;
}

export interface ThreadState {
  /** Every environment the page holds, in the order they were connected. */
  readonly environments: ReadonlyArray<ShellEnvironment>;
  /**
   * Every environment's threads, shelf by shelf, each shelf in its order
   * across the environments, as upstream's sidebar lists them; then the
   * subagents, on no shelf.
   */
  readonly threads: ReadonlyArray<ShellThread>;
  /** Every environment's projects, threads or none: a new thread's draft names its project. */
  readonly projects: ReadonlyArray<ShellProject>;
  /**
   * The Settled shelf: how many threads it holds, those the shells leave out
   * among them, which are read in pages as it shows more
   * (`showSettledThreads`, `model.ts`); whether a page is on its way, and
   * whether one failed.
   */
  readonly settled: { readonly count: number; readonly loading: boolean; readonly failed: boolean };
}

/** Whether `thread` is a subagent's, which has no card and no shelf of its own. */
export function isSubagent(thread: ShellThread): boolean {
  return thread.shelf === null && thread.parentId !== null;
}

/** A thread's or project's identity across environments, for maps and keys. */
export function scopedKey(environmentId: string, id: string): string {
  return `${environmentId}/${id}`;
}

/** What the mounted thread view knows of a thread's activity, from its projection. */
export interface ReportedActivity {
  readonly threadId: string;
  readonly working: boolean;
  readonly workingSince: string | null;
}

type Listener = (state: ThreadState) => void;

/**
 * The environments' threads, as the page's model (`model.ts`) presents them
 * from each connection's shell snapshot, with what the mounted thread view
 * reports of their activity laid over.
 */
class ThreadStore {
  private presented: ThreadState = { environments: [], threads: [], projects: [], settled: { count: 0, loading: false, failed: false } };
  private state: ThreadState = this.presented;
  /**
   * Whether threads work, as the mounted thread view knows from its
   * projection (`reportActivity`): a provider's native subagent has no run, so
   * the shell snapshot always reads it idle. Laid over the model's; kept
   * across thread switches, the last word on each thread until the next.
   */
  private readonly activity = new Map<string, ReportedActivity>();
  private readonly listeners = new Set<Listener>();

  /** The model's latest, which listeners hear with the reported activity laid over. */
  set(state: ThreadState): void {
    this.presented = state;
    this.update();
  }

  get(): ThreadState {
    return this.state;
  }

  /** What the thread view reports of its lineage's activity; a change re-renders, a repeat does not. */
  reportActivity(activity: ReadonlyArray<ReportedActivity>): void {
    let changed = false;
    for (const report of activity) {
      const known = this.activity.get(report.threadId);
      if (known?.working === report.working && known.workingSince === report.workingSince) continue;
      this.activity.set(report.threadId, report);
      changed = true;
    }
    if (changed) this.update();
  }

  private update(): void {
    const threads = this.presented.threads.map((thread) => {
      const reported = this.activity.get(thread.id);
      // A run the model sees working wins; the view's word fills in where the model has none.
      if (reported === undefined || thread.working) return thread;
      return { ...thread, working: reported.working, workingSince: reported.working ? reported.workingSince : null };
    });
    this.state = { ...this.presented, threads };
    for (const listener of this.listeners) listener(this.state);
  }

  /** A held environment by id. */
  environment(environmentId: string): ShellEnvironment | undefined {
    return this.state.environments.find((environment) => environment.id === environmentId);
  }

  /** The environment's name while the page holds several, to tell its threads and projects apart; undefined while it holds one. */
  distinguishing(environmentId: string): string | undefined {
    return this.state.environments.length > 1 ? this.environment(environmentId)?.name : undefined;
  }

  /** A thread by its environment and id. */
  thread(environmentId: string, threadId: string): ShellThread | undefined {
    return this.state.threads.find((thread) => thread.id === threadId && thread.environmentId === environmentId);
  }

  /** The environment of the first thread listed with `threadId`, for a caller that knows the id alone. */
  environmentOfThread(threadId: string): string | undefined {
    return this.state.threads.find((thread) => thread.id === threadId)?.environmentId;
  }

  /** A project by its environment and id: the environment's, or else what a thread of it says. */
  project(environmentId: string, projectId: string): ShellProject | undefined {
    const project = this.state.projects.find(
      (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
    );
    if (project !== undefined) return project;
    const thread = this.state.threads.find(
      (candidate) => candidate.projectId === projectId && candidate.environmentId === environmentId,
    );
    if (thread === undefined) return undefined;
    return {
      environmentId,
      id: projectId,
      name: thread.projectName,
      root: thread.projectRoot,
      icon: thread.projectIcon,
      faviconPath: thread.projectFaviconPath,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const threadStore = new ThreadStore();
