import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

/**
 * A thread as the extension reports it to the shell: the fields of its
 * `EnvironmentThreadShell` the pane shows, serialised over a command call.
 * The shape is owned by `shell-spike` in pult-extension (`src/shellBridge.ts`).
 */
export interface ShellThread {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly working: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly snoozed: boolean;
  readonly latestRun: { status: string; startedAt: string | null; finishedAt: string | null } | null;
  readonly goal: string | null;
}

export interface ShellEnvironment {
  readonly label: string;
  readonly phase: string;
}

export interface ThreadState {
  readonly environment: ShellEnvironment | null;
  readonly threads: ReadonlyArray<ShellThread>;
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
