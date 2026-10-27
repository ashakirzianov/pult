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

/** What a thread is doing, as its status reads: Working, Waiting on background work, or neither. */
type Activity = "working" | "waiting" | null;

/**
 * Each thread's activity: Waiting when upstream parks it on background work,
 * or while it does nothing itself but a subagent below it works; Working
 * while it works.
 */
function threadActivities(threads: ReadonlyArray<ShellThread>): Map<string, Activity> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const waitingOnSubagents = new Set<string>();
  for (const thread of threads) {
    if (!thread.working) continue;
    // Its ancestors up the lineage; one already marked has its own marked too.
    for (let id = thread.parentId; id !== null && !waitingOnSubagents.has(id); id = byId.get(id)?.parentId ?? null) {
      waitingOnSubagents.add(id);
    }
  }
  return new Map(
    threads.map((thread): [string, Activity] => [
      thread.id,
      thread.working ? (thread.waiting ? "waiting" : "working") : waitingOnSubagents.has(thread.id) ? "waiting" : null,
    ]),
  );
}

/** Each thread's subagents, nested ones too, by the thread at the top of their lineage: active first, then newest first. */
function subagentsByRoot(threads: ReadonlyArray<ShellThread>, activities: Map<string, Activity>): Map<string, ShellThread[]> {
  const byRoot = new Map<string, ShellThread[]>();
  for (const thread of threads) {
    if (!isSubagent(thread)) continue;
    const list = byRoot.get(thread.rootId) ?? [];
    list.push(thread);
    byRoot.set(thread.rootId, list);
  }
  for (const list of byRoot.values()) {
    const active = (thread: ShellThread) => Number(activities.get(thread.id) != null);
    list.sort((a, b) => active(b) - active(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
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
  const activities = threadActivities(state.threads);
  const subagents = subagentsByRoot(state.threads, activities);
  // The card the selection expands: the selected thread's own, or for a subagent its root's.
  const selectedThread = state.threads.find((thread) => thread.id === selection);
  const selectedCard = selectedThread !== undefined && isSubagent(selectedThread) ? selectedThread.rootId : selection;
  const card = (thread: ShellThread) => (
    <ThreadCard
      key={thread.id}
      thread={thread}
      subagents={subagents.get(thread.id) ?? []}
      activities={activities}
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
          <Shelf name="snoozed" label="Snoozed" count={snoozed.length}>
            {snoozed.map(card)}
          </Shelf>
        ) : null}
        {settled.length > 0 ? (
          <Shelf name="settled" label="Settled" count={settled.length}>
            <SettledTail threads={settled} selection={selectedCard} render={card} />
          </Shelf>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * Upstream's collapsible header: the label and its count, a rule, a status
 * when one is given, the chevron. A shelf's and a card's subagents'.
 */
function CollapsibleHeader({
  label,
  count,
  expanded,
  onToggle,
  status = null,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  status?: React.ReactNode;
}) {
  return (
    <button type="button" className="pult-shelf-header" aria-expanded={expanded} onClick={onToggle}>
      <span className="pult-shelf-label">{label}</span>
      <span className="pult-shelf-count">{count}</span>
      <span className="pult-shelf-rule" aria-hidden />
      {status}
      <i className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-up"}`} aria-hidden />
    </button>
  );
}

/**
 * A shelf under its collapsible header, its threads shown while expanded.
 * Whether it is expanded persists in localStorage, per shelf, as upstream
 * keeps its own.
 */
function Shelf({ name, label, count, children }: { name: ShelfName; label: string; count: number; children: React.ReactNode }) {
  const [expanded, setExpanded] = useExpanded(`pult-shell.panel.${name}-expanded`);
  return (
    <li className={`pult-shelf pult-shelf-${name}`}>
      <CollapsibleHeader label={label} count={count} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
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

/** A collapsible's state, kept in localStorage under `key`; collapsed until opened. */
function useExpanded(key: string): [boolean, (expanded: boolean) => void] {
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
 * T3 Code's thread card without its bottom row: project icon and name, pin
 * and status, then the title, as the button that selects the thread.
 * Selected, it expands with its subagents under their header, each selecting
 * its own thread, then one row: the branch when the server records one,
 * Explorer, the button that opens the Explorer tab narrowed to the thread's
 * root (a note when the thread has none), and the environment.
 */
function ThreadCard({
  thread,
  subagents,
  activities,
  environment,
  selected,
  selection,
  now,
}: {
  thread: ShellThread;
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
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
          <Status thread={thread} activity={activities.get(thread.id) ?? null} now={now} />
        </span>
        <span className="pult-card-title">{thread.title}</span>
      </button>
      {selected ? (
        <div className="pult-card-details">
          {subagents.length > 0 ? <Subagents subagents={subagents} activities={activities} selection={selection} now={now} /> : null}
          <div className="pult-card-row">
            {thread.branch ? (
              <span className="pult-card-branch">
                <i className="codicon codicon-git-branch" aria-hidden />
                {thread.branch}
              </span>
            ) : null}
            {thread.projectRoot === null ? (
              <span className="pult-card-note">No project folder</span>
            ) : (
              <button type="button" className="pult-card-action" onClick={() => run("pult-shell.openThreadExplorer")}>
                <i className="codicon codicon-files" aria-hidden />
                Explorer
              </button>
            )}
            {environment ? (
              <span className="pult-card-environment">
                <i className="codicon codicon-vm" aria-hidden />
                {environment.label}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The expanded card's subagents under one collapsible header, their count
 * and, while any works, Working with the longest elapsed time; collapsed
 * until opened, for every card at once. Each a row that selects its thread:
 * its title, then its status, a working one's being its elapsed time alone.
 * Active ones first; the selected one shown even while collapsed.
 */
function Subagents({
  subagents,
  activities,
  selection,
  now,
}: {
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  selection: string | undefined;
  now: number;
}) {
  const [expanded, setExpanded] = useExpanded("pult-shell.panel.subagents-expanded");
  const activity = (subagent: ShellThread) => activities.get(subagent.id) ?? null;
  const working = subagents.filter((subagent) => activity(subagent) === "working");
  // The longest elapsed time is the earliest start.
  const since = working
    .map((subagent) => subagent.workingSince)
    .filter((start) => start !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const shown = expanded ? subagents : subagents.filter((subagent) => subagent.id === selection);
  const row = (subagent: ShellThread) => (
    <li key={subagent.id}>
      <button
        type="button"
        className={`pult-subagent${subagent.id === selection ? " pult-subagent-selected" : ""}`}
        aria-current={subagent.id === selection || undefined}
        title={subagent.title}
        onClick={() => run("pult-shell.selectThread", subagent.id)}
      >
        <i className="codicon codicon-hubot" aria-hidden />
        <span className="pult-subagent-title">{subagent.title}</span>
        {activity(subagent) === "working" && subagent.workingSince !== null ? (
          <span className="pult-card-status pult-card-status-working">
            <Elapsed since={subagent.workingSince} />
          </span>
        ) : (
          <Status thread={subagent} activity={activity(subagent)} now={now} />
        )}
      </button>
    </li>
  );
  return (
    <div className="pult-card-subagents">
      <CollapsibleHeader
        label="Subagents"
        count={subagents.length}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        status={
          working.length === 0 ? null : (
            <span className="pult-card-status pult-card-status-working">
              Working{since === undefined ? null : <Elapsed since={since} />}
            </span>
          )
        }
      />
      {shown.length > 0 ? (
        <ul className="pult-subagents-list" aria-label="Subagents">
          {shown.map(row)}
        </ul>
      ) : null}
    </div>
  );
}

/** The card's top-right slot: the run state when it says something, else the thread's age. */
function Status({ thread, activity, now }: { thread: ShellThread; activity: Activity; now: number }) {
  if (activity === "working") {
    return (
      <span className="pult-card-status pult-card-status-working">
        Working{thread.workingSince === null ? null : <Elapsed since={thread.workingSince} />}
      </span>
    );
  }
  if (activity === "waiting") return <span className="pult-card-status pult-card-status-waiting">Waiting</span>;
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

/**
 * The time since `since`, ticking each second, in upstream's subagent form:
 * `45s`, `3m 05s`, `1h 02m`. Its own clock, so a tick re-renders only it.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
  if (Number.isNaN(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const text =
    minutes === 0
      ? `${seconds}s`
      : hours === 0
        ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
        : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return <span className="pult-card-elapsed">{text}</span>;
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
