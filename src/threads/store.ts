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
  readonly working: boolean;
  readonly pinned: boolean;
  readonly latestRun: { status: string; startedAt: string | null; finishedAt: string | null } | null;
  readonly goal: string | null;
}

export interface ShellEnvironment {
  readonly id: string;
  readonly label: string;
  readonly phase: string;
}

export interface ThreadState {
  readonly environment: ShellEnvironment | null;
  /** Shelf by shelf, each in its shelf's order, as upstream's sidebar lists them; then the subagents, on no shelf. */
  readonly threads: ReadonlyArray<ShellThread>;
}

/** Whether `thread` is a subagent's, which has no card and no shelf of its own. */
export function isSubagent(thread: ShellThread): boolean {
  return thread.shelf === null && thread.parentId !== null;
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
  private state: ThreadState = { environment: null, threads: [] };
  private readonly listeners = new Set<Listener>();

  constructor() {
    CommandsRegistry.registerCommand("pult-shell.threads", (_accessor, payload: ThreadState) => {
      this.state = payload;
      for (const listener of this.listeners) listener(payload);
    });
  }

  get(): ThreadState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const threadStore = new ThreadStore();
