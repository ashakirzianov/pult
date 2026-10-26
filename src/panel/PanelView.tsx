import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useEffect, useState, useSyncExternalStore } from "react";

import { projectIconUri } from "../threads/projectIcon.ts";
import { isSettingsSelected, onDidSelectThread, selectedThread } from "../threads/selection.ts";
import { isSubagent, type ShelfName, type ShellEnvironment, type ShellThread, threadStore } from "../threads/store.ts";

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

/** Upstream's settled tail: this many settled threads at first, then a page more per click. */
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

/** A card lists this many subagents, then the rest behind "Show more". */
const SUBAGENTS_SHOWN = 6;

/** Each thread's subagents, nested ones too, by the thread at the top of their lineage: working first, then newest first. */
function subagentsByRoot(threads: ReadonlyArray<ShellThread>): Map<string, ShellThread[]> {
  const byRoot = new Map<string, ShellThread[]>();
  for (const thread of threads) {
    if (!isSubagent(thread)) continue;
    const list = byRoot.get(thread.rootId) ?? [];
    list.push(thread);
    byRoot.set(thread.rootId, list);
  }
  for (const list of byRoot.values()) {
    list.sort((a, b) => Number(b.working) - Number(a.working) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  return byRoot;
}

/**
 * The Threads tab's view, under the sidebar's title row: the environment's
 * threads as cards, in the store's order, which is upstream's: pinned and
 * active as one flat list, then the Snoozed and Settled shelves, each under
 * a collapsible header, collapsed until opened. The selected card expands
 * with its details and its subagents; a subagent has no card, so while one
 * is selected its root's card is the expanded one.
 */
export function PanelView() {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  const listed = state.threads.filter((thread) => thread.shelf === "pinned" || thread.shelf === "active");
  const snoozed = state.threads.filter((thread) => thread.shelf === "snoozed");
  const settled = state.threads.filter((thread) => thread.shelf === "settled");
  const subagents = subagentsByRoot(state.threads);
  // The card the selection expands: the selected thread's own, or for a subagent its root's.
  const selectedThread = state.threads.find((thread) => thread.id === selection);
  const selectedCard = selectedThread !== undefined && isSubagent(selectedThread) ? selectedThread.rootId : selection;
  const card = (thread: ShellThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      subagents={subagents.get(thread.id) ?? []}
      environment={state.environment}
      selected={thread.id === selectedCard}
      selection={selection}
      now={now}
    />
  );
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
        ) : state.threads.length === 0 ? (
          <li className="pult-panel-empty">No threads in {state.environment.label}.</li>
        ) : listed.length === 0 ? (
          <li className="pult-panel-empty">No active threads.</li>
        ) : (
          listed.map(card)
        )}
        {snoozed.length > 0 ? (
          <Shelf name="snoozed" label="Snoozed">
            {snoozed.map(card)}
          </Shelf>
        ) : null}
        {settled.length > 0 ? (
          <Shelf name="settled" label="Settled">
            <SettledTail threads={settled} selection={selectedCard} render={card} />
          </Shelf>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * A shelf under upstream's collapsible header (label, rule, chevron), its
 * threads shown while expanded. Whether it is expanded persists in
 * localStorage, per shelf, as upstream keeps its own.
 */
function Shelf({ name, label, children }: { name: ShelfName; label: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useShelfExpanded(name);
  return (
    <li className={`pult-shelf pult-shelf-${name}`}>
      <button type="button" className="pult-shelf-header" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="pult-shelf-label">{label}</span>
        <span className="pult-shelf-rule" aria-hidden />
        <i className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-up"}`} aria-hidden />
      </button>
      {expanded ? <ul className="pult-shelf-cards">{children}</ul> : null}
    </li>
  );
}

/**
 * The settled shelf's tail: the first few threads, a page more per "Show
 * more", and the selected thread even when it lies beyond.
 */
function SettledTail({
  threads,
  selection,
  render,
}: {
  threads: ReadonlyArray<ShellThread>;
  selection: string | undefined;
  render: (thread: ShellThread) => React.ReactNode;
}) {
  const [count, setCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const visible = threads.slice(0, count);
  const beyond = threads.slice(count).find((thread) => thread.id === selection);
  if (beyond !== undefined) visible.push(beyond);
  const hidden = threads.length - visible.length;
  return (
    <>
      {visible.map(render)}
      {hidden > 0 ? (
        <li className="pult-shelf-more">
          <button type="button" className="pult-panel-button" onClick={() => setCount(count + SETTLED_TAIL_PAGE_COUNT)}>
            Show {Math.min(hidden, SETTLED_TAIL_PAGE_COUNT)} more
          </button>
        </li>
      ) : null}
    </>
  );
}

function useShelfExpanded(name: ShelfName): [boolean, (expanded: boolean) => void] {
  const key = `pult-shell.panel.${name}-expanded`;
  const [expanded, setExpanded] = useState(() => localStorage.getItem(key) === "true");
  return [
    expanded,
    (next) => {
      localStorage.setItem(key, String(next));
      setExpanded(next);
    },
  ];
}

/**
 * T3 Code's thread card without its bottom row: project icon and name, pin and status, then
 * the title, as the button that selects the thread. Selected, it expands with
 * one row: Explorer, the button that opens the Explorer tab narrowed to the
 * thread's root, or a note when the thread has none, then the branch and the
 * environment; and its subagents below, each selecting its own thread.
 */
function ThreadCard({
  thread,
  subagents,
  environment,
  selected,
  selection,
  now,
}: {
  thread: ShellThread;
  subagents: ReadonlyArray<ShellThread>;
  environment: ShellEnvironment | null;
  selected: boolean;
  selection: string | undefined;
  now: number;
}) {
  return (
    <li className={`pult-card${selected ? " pult-card-selected" : ""}${thread.shelf === "settled" ? " pult-card-settled" : ""}`}>
      <button
        type="button"
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={() => run("pult-shell.selectThread", thread.id)}
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={projectIconUri(thread.projectName, thread.projectIcon).toString(true)} alt="" />
          <span className="pult-card-project">{thread.projectName}</span>
          {thread.pinned ? <i className="codicon codicon-pinned pult-card-pin" title="Pinned" aria-label="Pinned" /> : null}
          <Status thread={thread} now={now} />
        </span>
        <span className="pult-card-title">{thread.title}</span>
      </button>
      {selected ? (
        <div className="pult-card-details">
          <div className="pult-card-row">
            {thread.projectRoot === null ? (
              <span className="pult-card-note">No project folder</span>
            ) : (
              <button type="button" className="pult-card-action" onClick={() => run("pult-shell.openThreadExplorer")}>
                <i className="codicon codicon-files" aria-hidden />
                Explorer
              </button>
            )}
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
          {subagents.length > 0 ? <Subagents subagents={subagents} selection={selection} now={now} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The expanded card's subagents, each a row that selects its thread: its
 * status, then its title. The first few, then the rest behind "Show more";
 * the selected one always.
 */
function Subagents({
  subagents,
  selection,
  now,
}: {
  subagents: ReadonlyArray<ShellThread>;
  selection: string | undefined;
  now: number;
}) {
  const [all, setAll] = useState(false);
  const visible = all ? [...subagents] : subagents.slice(0, SUBAGENTS_SHOWN);
  const beyond = subagents.slice(visible.length).find((subagent) => subagent.id === selection);
  if (beyond !== undefined) visible.push(beyond);
  const hidden = subagents.length - visible.length;
  return (
    <ul className="pult-card-subagents" aria-label="Subagents">
      {visible.map((subagent) => (
        <li key={subagent.id}>
          <button
            type="button"
            className={`pult-subagent${subagent.id === selection ? " pult-subagent-selected" : ""}`}
            aria-current={subagent.id === selection || undefined}
            title={subagent.title}
            onClick={() => run("pult-shell.selectThread", subagent.id)}
          >
            <i className={`codicon ${subagent.working ? "codicon-loading codicon-modifier-spin" : "codicon-hubot"}`} aria-hidden />
            <span className="pult-subagent-title">{subagent.title}</span>
            <Status thread={subagent} now={now} />
          </button>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <button type="button" className="pult-subagent pult-subagent-more" onClick={() => setAll(true)}>
            Show {hidden} more
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** The card's top-right slot: the run state when it says something, else the thread's age. */
function Status({ thread, now }: { thread: ShellThread; now: number }) {
  if (thread.working) return <span className="pult-card-status pult-card-status-working">Working</span>;
  if (thread.latestRun?.status === "failed") return <span className="pult-card-status pult-card-status-failed">Failed</span>;
  if (thread.shelf === "snoozed") {
    return (
      <span className="pult-card-status">
        <i className="codicon codicon-bell-slash" aria-hidden /> Snoozed
      </span>
    );
  }
  if (thread.shelf === "settled") {
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
