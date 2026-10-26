import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useEffect, useState, useSyncExternalStore } from "react";

import { isSettingsSelected, onDidSelectThread, selectedThread } from "../threads/selection.ts";
import { type ShellEnvironment, type ShellThread, threadStore } from "../threads/store.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** What the editor part shows, as a stable snapshot: a thread id, `settings`, or nothing. */
function selectionSnapshot(): string | undefined {
  return isSettingsSelected() ? "settings" : selectedThread()?.threadId;
}

/** The thread store for `useSyncExternalStore`, at module level so a render does not re-subscribe. */
const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/**
 * The Threads tab's view, under the sidebar's title row: the environment's
 * threads as cards, a flat list in the store's order, pinned first. The
 * selected card expands with its details.
 */
export function PanelView() {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  const threads = [...state.threads].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <div className="pult-panel">
      <ul className="pult-panel-cards">
        {state.environment === null ? (
          <li className="pult-panel-empty">
            <p>Not connected.</p>
            <button type="button" className="pult-panel-button" onClick={() => run("pult.connect")}>
              Connect to Environment
            </button>
          </li>
        ) : threads.length === 0 ? (
          <li className="pult-panel-empty">No threads in {state.environment.label}.</li>
        ) : (
          threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              environment={state.environment}
              selected={thread.id === selection}
              now={now}
            />
          ))
        )}
      </ul>
    </div>
  );
}

/**
 * T3 Code's thread card without its bottom row: project, pin and status, then
 * the title, as the button that selects the thread. Selected, it expands with
 * the row (branch, environment) and the button that opens the Explorer tab
 * narrowed to the thread's root, or a note when the thread has none.
 */
function ThreadCard({
  thread,
  environment,
  selected,
  now,
}: {
  thread: ShellThread;
  environment: ShellEnvironment | null;
  selected: boolean;
  now: number;
}) {
  return (
    <li className={`pult-card${selected ? " pult-card-selected" : ""}${thread.settled ? " pult-card-settled" : ""}`}>
      <button
        type="button"
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={() => run("pult-shell.selectThread", thread.id)}
      >
        <span className="pult-card-top">
          <span className="pult-card-project">{thread.projectName}</span>
          {thread.pinned ? <i className="codicon codicon-pinned pult-card-pin" title="Pinned" aria-label="Pinned" /> : null}
          <Status thread={thread} now={now} />
        </span>
        <span className="pult-card-title">{thread.title}</span>
      </button>
      {selected ? (
        <div className="pult-card-details">
          <div className="pult-card-row">
            {thread.branch ? (
              <span className="pult-card-branch">
                <i className="codicon codicon-git-branch" aria-hidden />
                {thread.branch}
              </span>
            ) : null}
            {environment ? (
              <span className="pult-card-environment">
                <i className="codicon codicon-vm" aria-hidden />
                {environment.label}
              </span>
            ) : null}
          </div>
          {thread.projectRoot === null ? (
            <span className="pult-card-note">No project folder to explore.</span>
          ) : (
            <button type="button" className="pult-panel-button" onClick={() => run("pult-shell.openThreadExplorer")}>
              <i className="codicon codicon-files" aria-hidden />
              Open explorer
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** The card's top-right slot: the run state when it says something, else the thread's age. */
function Status({ thread, now }: { thread: ShellThread; now: number }) {
  if (thread.working) return <span className="pult-card-status pult-card-status-working">Working</span>;
  if (thread.latestRun?.status === "failed") return <span className="pult-card-status pult-card-status-failed">Failed</span>;
  if (thread.snoozed) {
    return (
      <span className="pult-card-status">
        <i className="codicon codicon-bell-slash" aria-hidden /> Snoozed
      </span>
    );
  }
  if (thread.settled) {
    return (
      <span className="pult-card-status">
        <i className="codicon codicon-check" aria-hidden /> {age(thread.updatedAt, now)}
      </span>
    );
  }
  return <span className="pult-card-status">{age(thread.updatedAt, now)}</span>;
}

/** The time since `iso`, in T3 Code's short form: `now`, `5m`, `3h`, `2d`. */
function age(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The current time, updated once a minute, so the ages do not go stale. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
