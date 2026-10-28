import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useEffect, useState, useSyncExternalStore } from "react";

import { settleThread, showSnoozeMenu, showThreadMenu, unsettleThread, wakeThread } from "../threads/park.ts";
import { parkActions } from "../threads/parking.ts";
import { NO_THREAD_FEATURES } from "../threads/presentation.ts";
import { projectIconUri } from "../threads/projectIcon.ts";
import { onDidSelectThread, selectedDraft, selectedThread } from "../threads/selection.ts";
import {
  isSubagent,
  scopedKey,
  type ShelfName,
  type ShellThread,
  type ThreadFeatures,
  threadStore,
} from "../threads/store.ts";
import { DraftCard, EnvironmentChip } from "./DraftCard.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** A thread's identity across environments (`scopedKey`), which the selection and the panel's maps go by. */
const keyOf = (thread: ShellThread) => scopedKey(thread.environmentId, thread.id);

/** What the editor part shows, as a stable snapshot: a thread's key, a project's draft, or nothing. */
function selectionSnapshot(): string | undefined {
  const draft = selectedDraft();
  if (draft !== undefined) return `${DRAFT_PREFIX}${scopedKey(draft.environmentId, draft.projectId)}`;
  const thread = selectedThread();
  return thread && scopedKey(thread.environmentId, thread.threadId);
}

const DRAFT_PREFIX = "draft:";

/** The thread store for `useSyncExternalStore`, at module level so a render does not re-subscribe. */
const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** Upstream's settled tail: this many settled threads at first, then a page more per click. */
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

/** What a thread is doing, as its status reads: Working, Waiting on background work, or neither. */
type Activity = "working" | "waiting" | null;

/**
 * Each thread's activity, by its key: Waiting when upstream parks it on
 * background work, or while it does nothing itself but a subagent below it
 * works; Working while it works.
 */
function threadActivities(threads: ReadonlyArray<ShellThread>): Map<string, Activity> {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread]));
  const parentOf = (thread: ShellThread | undefined) =>
    thread?.parentId == null ? null : scopedKey(thread.environmentId, thread.parentId);
  const waitingOnSubagents = new Set<string>();
  for (const thread of threads) {
    if (!thread.working) continue;
    // Its ancestors up the lineage; one already marked has its own marked too.
    for (let key = parentOf(thread); key !== null && !waitingOnSubagents.has(key); key = parentOf(byKey.get(key))) {
      waitingOnSubagents.add(key);
    }
  }
  return new Map(
    threads.map((thread): [string, Activity] => [
      keyOf(thread),
      thread.working ? (thread.waiting ? "waiting" : "working") : waitingOnSubagents.has(keyOf(thread)) ? "waiting" : null,
    ]),
  );
}

/** Each thread's subagents, nested ones too, by the key of the thread at the top of their lineage: active first, then newest first. */
function subagentsByRoot(threads: ReadonlyArray<ShellThread>, activities: Map<string, Activity>): Map<string, ShellThread[]> {
  const byRoot = new Map<string, ShellThread[]>();
  for (const thread of threads) {
    if (!isSubagent(thread)) continue;
    const root = scopedKey(thread.environmentId, thread.rootId);
    const list = byRoot.get(root) ?? [];
    list.push(thread);
    byRoot.set(root, list);
  }
  for (const list of byRoot.values()) {
    const active = (thread: ShellThread) => Number(activities.get(keyOf(thread)) != null);
    list.sort((a, b) => active(b) - active(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  return byRoot;
}

/**
 * The Threads tab's view, under the sidebar's title row: every held
 * environment's threads as cards, in the store's order, which is upstream's:
 * pinned and active as one flat list, then the Snoozed and Settled shelves,
 * each under a collapsible header, collapsed until opened. While the page
 * holds several environments, each card names its own. The selected card
 * expands with its details and its subagents; a subagent has no card, so
 * while one is selected its root's card is the expanded one. A selected
 * draft of a new thread has a card of its own at the top.
 */
export function PanelView() {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  const draft = selection?.startsWith(DRAFT_PREFIX) ? selectedDraft() : undefined;
  const listed = state.threads.filter((thread) => thread.shelf === "pinned" || thread.shelf === "active");
  const snoozed = state.threads.filter((thread) => thread.shelf === "snoozed");
  const settled = state.threads.filter((thread) => thread.shelf === "settled");
  const activities = threadActivities(state.threads);
  const subagents = subagentsByRoot(state.threads, activities);
  const environments = new Map(state.environments.map((environment) => [environment.id, environment]));
  /** The environment's name on its cards, while there are several to tell apart. */
  const chip = (environmentId: string) => (state.environments.length > 1 ? environments.get(environmentId)?.name : undefined);
  // The card the selection expands: the selected thread's own, or for a subagent its root's.
  const selectedThread = state.threads.find((thread) => keyOf(thread) === selection);
  const selectedCard =
    selectedThread !== undefined && isSubagent(selectedThread)
      ? scopedKey(selectedThread.environmentId, selectedThread.rootId)
      : selection;
  const card = (thread: ShellThread) => (
    <ThreadCard
      key={keyOf(thread)}
      thread={thread}
      environment={chip(thread.environmentId)}
      subagents={subagents.get(keyOf(thread)) ?? []}
      activities={activities}
      features={environments.get(thread.environmentId)?.features ?? NO_THREAD_FEATURES}
      selected={keyOf(thread) === selectedCard}
      selection={selection}
      now={now}
    />
  );
  return (
    <div className="pult-panel">
      <ul className="pult-panel-cards">
        {draft !== undefined && environments.has(draft.environmentId) ? (
          <DraftCard environmentId={draft.environmentId} projectId={draft.projectId} environment={chip(draft.environmentId)} />
        ) : null}
        {state.environments.length === 0 ? (
          <li className="pult-panel-empty">
            <p>Not connected.</p>
            <button type="button" className="pult-panel-button" onClick={() => run("pult-shell.connect")}>
              Connect to Environment
            </button>
          </li>
        ) : state.threads.length === 0 ? (
          <li className="pult-panel-empty">No threads in {state.environments.map((environment) => environment.label).join(", ")}.</li>
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
  const beyond = threads.slice(count).find((thread) => keyOf(thread) === selection);
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
 * T3 Code's thread card without its bottom row: project icon and name, its
 * `environment`'s label beside them while there are several (`EnvironmentChip`),
 * pin and status, then the title, as the button that selects the thread; on
 * hover or keyboard focus the status gives way to the thread's actions
 * (`StatusSlot`), and a right-click opens its menu (`showThreadMenu`).
 * Selected, it expands with its subagents under their header, each selecting
 * its own thread; the thread's place, Explorer, its branch and environment,
 * is in its pane's composer bar (`src/threads/barEntries.tsx`).
 */
function ThreadCard({
  thread,
  environment,
  subagents,
  activities,
  features,
  selected,
  selection,
  now,
}: {
  thread: ShellThread;
  environment: string | undefined;
  subagents: ReadonlyArray<ShellThread>;
  activities: Map<string, Activity>;
  features: ThreadFeatures;
  selected: boolean;
  selection: string | undefined;
  now: number;
}) {
  const select = () => run("pult-shell.selectThread", thread.environmentId, thread.id);
  return (
    <li className={`pult-card${selected ? " pult-card-selected" : ""}${thread.shelf === "settled" ? " pult-card-settled" : ""}`}>
      {/* A button by role, as upstream's card: its actions are buttons inside it. */}
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={select}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          select();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showThreadMenu(thread, { x: event.clientX, y: event.clientY });
        }}
      >
        <span className="pult-card-top">
          <img className="pult-card-icon" src={projectIconUri(thread.projectName, thread.projectIcon).toString(true)} alt="" />
          <span className="pult-card-project">{thread.projectName}</span>
          <EnvironmentChip label={environment} />
          {thread.pinned ? <i className="codicon codicon-pinned pult-card-pin" title="Pinned" aria-label="Pinned" /> : null}
          <StatusSlot thread={thread} features={features}>
            <Status thread={thread} activity={activities.get(keyOf(thread)) ?? null} now={now} />
          </StatusSlot>
        </span>
        <span className="pult-card-title">{thread.title}</span>
      </div>
      {selected && subagents.length > 0 ? (
        <div className="pult-card-details">
          <Subagents subagents={subagents} activities={activities} selection={selection} now={now} />
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
  const activity = (subagent: ShellThread) => activities.get(keyOf(subagent)) ?? null;
  const working = subagents.filter((subagent) => activity(subagent) === "working");
  // The longest elapsed time is the earliest start.
  const since = working
    .map((subagent) => subagent.workingSince)
    .filter((start) => start !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const shown = expanded ? subagents : subagents.filter((subagent) => keyOf(subagent) === selection);
  const row = (subagent: ShellThread) => (
    <li key={keyOf(subagent)}>
      <button
        type="button"
        className={`pult-subagent${keyOf(subagent) === selection ? " pult-subagent-selected" : ""}`}
        aria-current={keyOf(subagent) === selection || undefined}
        title={subagent.title}
        onClick={() => run("pult-shell.selectThread", subagent.environmentId, subagent.id)}
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

/**
 * The card's top-right slot: its status, giving way on hover or keyboard
 * focus to the thread's actions, as upstream's card: on a pinned or active
 * card the snooze clock (while the thread can be snoozed now) and Settle, on
 * a snoozed one Wake, on a settled one Un-settle, each while the server has
 * the feature. The actions stay shown while the clock's menu is open, and a
 * click on one does not select the card.
 */
function StatusSlot({ thread, features, children }: { thread: ShellThread; features: ThreadFeatures; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const offered = parkActions(thread, features);
  const onCard = thread.shelf === "pinned" || thread.shelf === "active";
  const actions = [
    onCard && offered.snooze && thread.canSnooze ? (
      <button
        key="snooze"
        type="button"
        title="Snooze"
        aria-label="Snooze thread"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          setMenuOpen(true);
          void showSnoozeMenu(thread, event.currentTarget, () => setMenuOpen(false));
        }}
      >
        <i className="codicon codicon-clock" aria-hidden />
      </button>
    ) : null,
    onCard && offered.settle ? (
      <button key="settle" type="button" title="Settle thread" onClick={() => void settleThread(thread)}>
        <i className="codicon codicon-check" aria-hidden />
        Settle
      </button>
    ) : null,
    offered.wake ? (
      <button key="wake" type="button" title="Wake thread" aria-label="Wake thread" onClick={() => wakeThread(thread)}>
        <i className="codicon codicon-bell" aria-hidden />
      </button>
    ) : null,
    offered.unsettle ? (
      <button key="unsettle" type="button" title="Un-settle thread" aria-label="Un-settle thread" onClick={() => unsettleThread(thread)}>
        <i className="codicon codicon-discard" aria-hidden />
      </button>
    ) : null,
  ].filter((action) => action !== null);
  if (actions.length === 0) return <>{children}</>;
  return (
    <span className={`pult-card-slot${menuOpen ? " pult-card-slot-open" : ""}`}>
      {children}
      {/* Clicks stop here, short of the card that selects the thread. */}
      <span className="pult-card-actions" onClick={(event) => event.stopPropagation()}>
        {actions}
      </span>
    </span>
  );
}

/** A card's or a subagent's status: the run state when it says something, else the thread's age. */
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
