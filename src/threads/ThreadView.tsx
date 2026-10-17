import { useSyncExternalStore } from "react";

import { type ShellThread, threadStore } from "./store.ts";

/**
 * A thread rendered by the shell: plain React in the page, in a workbench
 * editor pane. Crude on purpose: the extension hands the shell the thread's
 * shell (title, project, run state) tonight; its turns come once the shell
 * owns the connection and mounts the thread view the extension's webview
 * mounts today.
 */
export function ThreadView({ threadId }: { threadId: string }) {
  const state = useSyncExternalStore(
    (listener) => threadStore.subscribe(listener),
    () => threadStore.get(),
  );
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) {
    return (
      <div className="pult-thread pult-thread-empty">
        {state.environment === null ? "Not connected." : `No thread ${threadId} in ${state.environment.label}.`}
      </div>
    );
  }
  return (
    <article className="pult-thread">
      <header>
        <div className="pult-thread-project">
          {thread.projectName}
          {thread.branch ? ` · ${thread.branch}` : ""}
        </div>
        <h1>{thread.title}</h1>
        <div className="pult-thread-meta">
          <Status thread={thread} />
          <span>updated {relative(thread.updatedAt)}</span>
          <span>created {relative(thread.createdAt)}</span>
        </div>
      </header>
      {thread.goal ? <p className="pult-thread-goal">{thread.goal}</p> : null}
      <section className="pult-thread-body">
        <p className="pult-thread-note">
          Rendered in-process by the shell (React, no webview) inside VS Code's editor group. The turns of the
          thread would mount here from upstream's thread view once the shell owns the connection.
        </p>
      </section>
    </article>
  );
}

function Status({ thread }: { thread: ShellThread }) {
  const label = thread.working
    ? "working"
    : thread.snoozed
      ? "snoozed"
      : thread.settled
        ? "settled"
        : (thread.latestRun?.status ?? "idle");
  return (
    <span className={`pult-thread-status pult-thread-status-${thread.working ? "working" : "idle"}`}>{label}</span>
  );
}

function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
