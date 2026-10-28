import type * as Context from "effect/Context";

import type { ShellConnectionServices } from "./connectionRuntime.ts";

/**
 * What Pult's shell hands its in-process thread view (`main.tsx`): the
 * services of the page's connection runtime, which the view's state runtime
 * runs on, every environment's, where a thread the view navigates to opens,
 * where a project's new thread does, and where what the view would show in
 * its right panel goes instead (`rightPanel.ts`): a file, as a path relative
 * to the thread's project root or an absolute host path, with a line to
 * reveal; the thread's changes, with a file's path when one was named; and
 * what the view knows of its lineage's activity. Each names its
 * environment, as a pane mounts the view on one (`ThreadViewMounts`). It
 * also hands the colour scheme the view takes as the system's. The shell's
 * side is its `src/threads/pane.tsx`.
 */
export interface ThreadViewHost {
  readonly connection: () => Promise<Context.Context<ShellConnectionServices>>;
  readonly openThread: (environmentId: string, threadId: string) => void;
  /**
   * A new thread in the project, which the view went to (upstream's New
   * thread on branch, send and new): the shell selects the project's draft,
   * whose view takes up the draft the view remembered for the project.
   */
  readonly openDraft: (environmentId: string, projectId: string) => void;
  readonly openFile: (environmentId: string, threadId: string, path: string, line: number | null) => void;
  readonly openChanges: (environmentId: string, threadId: string, path: string | null) => void;
  /**
   * Whether threads of the mounted thread's lineage are working, as its
   * projection knows them: its subagents' from its roster, its own when it is
   * a provider's native subagent, whose work has no run the thread list sees;
   * with when the work started, when known.
   */
  readonly reportActivity: (
    activity: ReadonlyArray<{
      readonly threadId: string;
      readonly working: boolean;
      readonly workingSince: string | null;
    }>,
  ) => void;
  /**
   * The colour scheme the view's theme follows in its System mode, as the
   * system's: the workbench theme's, light or dark (`main.tsx`).
   */
  readonly colorScheme: () => "light" | "dark";
  /** Calls `listener` when `colorScheme` changes; returns its removal. */
  readonly onDidChangeColorScheme: (listener: () => void) => () => void;
}

let current: ThreadViewHost | undefined;
let resolveStarted: (host: ThreadViewHost) => void = () => {};
const started = new Promise<ThreadViewHost>((resolve) => {
  resolveStarted = resolve;
});

/** Set once, by `startThreadView`, before any view mounts. */
export function setThreadViewHost(host: ThreadViewHost): void {
  current = host;
  resolveStarted(host);
}

/**
 * The host once the shell has started the view. The view's modules read
 * state atoms as they load (upstream's theme, applied on import, reads the
 * environment's themes), which builds the connection runtime before the
 * shell can start the view; the runtime waits here rather than failing.
 */
export function threadViewHostStarted(): Promise<ThreadViewHost> {
  return started;
}

export function threadViewHost(): ThreadViewHost {
  if (current === undefined)
    throw new Error("The thread view mounted before the shell started it.");
  return current;
}
