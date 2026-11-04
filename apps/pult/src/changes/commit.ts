// A checkout's commit as its source control shows it, apart from the
// workbench so `node --test src/changes/commit.test.ts` can run it.
import type { GitActionProgressEvent, GitRunStackedActionResult } from "@t3tools/contracts";

/** What a commit's progress events have said so far: the step under way, the latest hook output, and how it ended. */
export interface CommitProgress {
  /** The step the commit button reads while it runs: the server's phase, or the hook it runs. */
  readonly label: string;
  readonly phaseLabel: string;
  /** A hook's latest line of output, while one runs or once one has failed. */
  readonly output: string | null;
  /** The server's message when the action failed. */
  readonly failure: string | null;
  readonly result: GitRunStackedActionResult | null;
}

/** An action's progress before the server's first event, reading `label`. */
export function actionStarted(label: string): CommitProgress {
  return { label, phaseLabel: label, output: null, failure: null, result: null };
}

export const COMMIT_STARTED = actionStarted("Committing…");

/** The progress after one of the server's events, as upstream's source control control follows them. */
export function commitProgress(current: CommitProgress, event: GitActionProgressEvent): CommitProgress {
  switch (event.kind) {
    case "action_started":
      return current;
    case "phase_started": {
      const label = ellipsis(event.label);
      return { ...current, label, phaseLabel: label, output: null };
    }
    case "hook_started":
      return { ...current, label: `Running ${event.hookName}…`, output: null };
    case "hook_output":
      return { ...current, output: event.text };
    case "hook_finished":
      // A failed hook's output stays for the failure's notification.
      return { ...current, label: current.phaseLabel, output: event.exitCode === 0 ? null : current.output };
    case "action_finished":
      return { ...current, result: event.result };
    case "action_failed":
      return { ...current, failure: event.message };
  }
}

/** The server's three dots as one character, as the workbench writes them. */
function ellipsis(label: string): string {
  return label.replace(/\.\.\.$/, "…");
}

/** Why a commit failed: the server's message, or else the stream's error, then a hook's last line of output when the message does not hold it. */
export function commitFailure(progress: CommitProgress, error: unknown): string {
  // What the connection rejects with need not be an `Error`: anything carrying a message gives it.
  const message = progress.failure ?? (typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));
  const output = progress.output?.trim();
  return output === undefined || output === "" || message.includes(output) ? message : `${message} ${output}`;
}

/** The message box's placeholder, `{0}` the workbench's Accept Input keybinding, as the git extension words it. */
export function commitPlaceholder(branch: string | null): string {
  return branch === null ? "Message ({0} to commit)" : `Message ({0} to commit on "${branch}")`;
}
