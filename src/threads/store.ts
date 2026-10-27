import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import type { ProjectIconOverride } from "@t3tools/contracts";

/** Upstream's sidebar shelves, in its order; the extension puts every listed thread on one. */
export type ShelfName = "pinned" | "active" | "snoozed" | "settled";

/**
 * A thread as the extension reports it to the shell: the fields of its
 * `EnvironmentThreadShell` the pane shows, serialised over a command call.
 * The shape is owned by `shell-spike` in pult-extension (`src/shellBridge.ts`).
 */
export interface ShellThread {
  readonly id: string;
  /** Its shelf; null for a subagent, which the panel lists under its root's card. */
  readonly shelf: ShelfName | null;
  /** The thread that spawned or forked it; null for a thread of its own. */
  readonly parentId: string | null;
  /** The top of its lineage, itself for a thread of its own. */
  readonly rootId: string;
  readonly projectId: string;
  readonly projectName: string;
  /** The project's root on the environment host, for `pult:` URIs. */
  readonly projectRoot: string | null;
  /** The project's chosen icon; null for the one upstream derives from its name. */
  readonly projectIcon: ProjectIconOverride | null;
  readonly title: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** In motion: working, or waiting on background work that will wake it. */
  readonly working: boolean;
  /** Upstream's Waiting: stopped, its run held open by background work, such as subagents, that will wake it. */
  readonly waiting: boolean;
  /** When its current work started, while it works and the server knows. */
  readonly workingSince: string | null;
  readonly pinned: boolean;
  /** Whether it may be snoozed now, as of the push: no pending approval or input, no queued turn start. */
  readonly canSnooze: boolean;
  readonly latestRun: { status: string; startedAt: string | null; finishedAt: string | null } | null;
  readonly goal: string | null;
}

export interface ShellEnvironment {
  readonly id: string;
  readonly label: string;
  readonly phase: string;
}

/** What the environment's server lets a client do to a thread; each off until it says. */
export interface ThreadFeatures {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
}

/** A project of the environment, threads or none: what a new thread's draft shows of it. */
export interface ShellProject {
  readonly id: string;
  readonly name: string;
  /** Its root on the environment host, for `pult:` URIs; null when only a thread's word on it, without one, is known. */
  readonly root: string | null;
  /** Its chosen icon; null for the one upstream derives from its name. */
  readonly icon: ProjectIconOverride | null;
}

export interface ThreadState {
  readonly environment: ShellEnvironment | null;
  readonly features: ThreadFeatures;
  /** Shelf by shelf, each in its shelf's order, as upstream's sidebar lists them; then the subagents, on no shelf. */
  readonly threads: ReadonlyArray<ShellThread>;
  /** The environment's projects; empty from an extension that does not push them. */
  readonly projects: ReadonlyArray<ShellProject>;
}

/** Whether `thread` is a subagent's, which has no card and no shelf of its own. */
export function isSubagent(thread: ShellThread): boolean {
  return thread.shelf === null && thread.parentId !== null;
}

/** What the mounted thread view knows of a thread's activity, from its projection. */
export interface ReportedActivity {
  readonly threadId: string;
  readonly working: boolean;
  readonly workingSince: string | null;
}

type Listener = (state: ThreadState) => void;

/**
 * The shell's copy of the extension's thread model, in the page. The extension
 * pushes it by executing the `pult-shell.threads` command, which the shell
 * registers in the main thread: an extension's `executeCommand` reaches
 * commands registered below the extension API, so this is the in-process
 * channel from the extension host into Pult's own UI, with no webview between.
 */
class ThreadStore {
  private pushed: ThreadState = {
    environment: null,
    features: { settlement: false, snooze: false, pinning: false },
    threads: [],
    projects: [],
  };
  private state: ThreadState = this.pushed;
  /**
   * Whether threads work, as the mounted thread view knows from its
   * projection (`reportActivity`): a provider's native subagent has no run, so
   * the extension's push always reads it idle. Laid over the push; kept
   * across thread switches, the last word on each thread until the next.
   */
  private readonly activity = new Map<string, ReportedActivity>();
  private readonly listeners = new Set<Listener>();

  constructor() {
    CommandsRegistry.registerCommand("pult-shell.threads", (_accessor, payload: ThreadState) => {
      this.pushed = { ...payload, projects: payload.projects ?? [] };
      this.update();
    });
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
    const threads = this.pushed.threads.map((thread) => {
      const reported = this.activity.get(thread.id);
      // A run the push sees working wins; the view's word fills in where the push has none.
      if (reported === undefined || thread.working) return thread;
      return { ...thread, working: reported.working, workingSince: reported.working ? reported.workingSince : null };
    });
    this.state = { ...this.pushed, threads };
    for (const listener of this.listeners) listener(this.state);
  }

  /** A project by id: the pushed one, or else what a thread of it says, for an extension that does not push them. */
  project(projectId: string): ShellProject | undefined {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (project !== undefined) return project;
    const thread = this.state.threads.find((candidate) => candidate.projectId === projectId);
    if (thread === undefined) return undefined;
    return { id: projectId, name: thread.projectName, root: thread.projectRoot, icon: thread.projectIcon };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const threadStore = new ThreadStore();
