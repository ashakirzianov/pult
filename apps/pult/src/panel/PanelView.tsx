import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useEffect, useState, useSyncExternalStore } from "react";

import { starStore } from "../stars/model.ts";
import { starEnabled } from "../stars/settings.ts";
import type { Star } from "../stars/stars.ts";
import { retrySettledThreads, showSettledThreads } from "../threads/model.ts";
import {
  settleThread,
  showSnoozeMenu,
  showThreadMenu,
  unsettleThread,
  wakeThread,
} from "../threads/park.ts";
import { parkActions } from "../threads/parking.ts";
import { NO_THREAD_FEATURES } from "../threads/presentation.ts";
import { projectIconUri, threadProjectIcon, useProjectIcons } from "../threads/projectIcon.ts";
import { onDidSelectThread, selectedDraft } from "../threads/selection.ts";
import {
  isSubagent,
  scopedKey,
  type ShellThread,
  type ThreadFeatures,
  type ThreadState,
  threadStore,
} from "../threads/store.ts";
import { CollapsibleHeader, useExpanded } from "./collapsible.tsx";
import { DraftCard, EnvironmentChip } from "./DraftCard.tsx";
import {
  isStarDraft,
  type ProjectDraft,
  projectDrafts,
  threadsWithUnsentMessages,
} from "./drafts.ts";
import { ExplorerShelf } from "./ExplorerShelf.tsx";
import { EXPANDED_KEYS, selectionSnapshot, showingSettled } from "./jump.ts";
import { JumpHint } from "./JumpHint.tsx";
import { LimitsShelf } from "./LimitsShelf.tsx";
import {
  draftCards as draftCardsOf,
  draftKey,
  keyOf,
  SETTLED_TAIL_INITIAL_COUNT,
  SETTLED_TAIL_PAGE_COUNT,
  settledTail,
  starKey,
} from "./order.ts";
import { StarCard } from "./StarCard.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/** The thread store for `useSyncExternalStore`, at module level so a render does not re-subscribe. */
const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** What a thread is doing, as its status reads: Working, Waiting on background work, or neither. */
export type Activity = "working" | "waiting" | null;

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
    for (
      let key = parentOf(thread);
      key !== null && !waitingOnSubagents.has(key);
      key = parentOf(byKey.get(key))
    ) {
      waitingOnSubagents.add(key);
    }
  }
  return new Map(
    threads.map((thread): [string, Activity] => [
      keyOf(thread),
      thread.working
        ? thread.waiting
          ? "waiting"
          : "working"
        : waitingOnSubagents.has(keyOf(thread))
          ? "waiting"
          : null,
    ]),
  );
}

/** Each thread's subagents, nested ones too, by the key of the thread at the top of their lineage: active first, then newest first. */
function subagentsByRoot(
  threads: ReadonlyArray<ShellThread>,
  activities: Map<string, Activity>,
): Map<string, ShellThread[]> {
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
 * The Pult tab's view, under the sidebar's title row: every held
 * environment's threads as cards, in the store's order, which is upstream's:
 * pinned and active under Ready, open until closed and left out while it
 * holds nothing, then the Working, Snoozed
 * and Settled shelves, collapsed until opened, each under a collapsible
 * header. While the page holds several environments, each card names its
 * own. The selected card expands with its details and its subagents; a
 * subagent has no card, so while one is selected its root's card is the
 * expanded one. The Stars' cards come first, under no header, while Show
 * Star is on (`StarCard.tsx`, `src/stars/`); a Star's threads have no card
 * of their own. The Explorer shelf comes next (`ExplorerShelf.tsx`), and
 * Ready's first cards are the projects' drafts of new threads that hold
 * something (`drafts.ts`), newest first, and the selected draft. Cmd+1 to
 * Cmd+9 jump to its rows in this order (`order.ts`, `jump.ts`). The Limits
 * shelf comes last (`LimitsShelf.tsx`), its rows no jump targets.
 */
export function PanelView() {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const now = useMinuteClock();
  // Read on the selection's change, which re-renders the panel.
  const draft = selectedDraft();
  const drafts = useSyncExternalStore(projectDrafts.subscribe, projectDrafts.get);
  const listed = state.threads.filter(
    (thread) => thread.shelf === "pinned" || thread.shelf === "active",
  );
  const working = state.threads.filter((thread) => thread.shelf === "working");
  const snoozed = state.threads.filter((thread) => thread.shelf === "snoozed");
  const settled = state.threads.filter((thread) => thread.shelf === "settled");
  const activities = threadActivities(state.threads);
  const subagents = subagentsByRoot(state.threads, activities);
  const environments = new Map(
    state.environments.map((environment) => [environment.id, environment]),
  );
  /** The environment's name on its cards, while there are several to tell apart. */
  const chip = (environmentId: string) =>
    state.environments.length > 1 ? environments.get(environmentId)?.name : undefined;
  // The card the selection expands: the selected thread's own, or for a subagent its root's.
  const selectedThread = state.threads.find((thread) => keyOf(thread) === selection);
  const selectedCard =
    selectedThread !== undefined && isSubagent(selectedThread)
      ? scopedKey(selectedThread.environmentId, selectedThread.rootId)
      : selection;
  // The drafts with something in them, and the selected one even while it is empty, first.
  const isSelectedDraft = (candidate: ProjectDraft) => draftKey(candidate) === selection;
  const draftCards = draftCardsOf(drafts, draft, new Set(environments.keys()), isStarDraft);
  const draftCard = (candidate: ProjectDraft) => (
    <DraftCard
      key={draftKey(candidate)}
      environmentId={candidate.environmentId}
      projectId={candidate.projectId}
      environment={chip(candidate.environmentId)}
      preview={candidate.preview}
      selected={isSelectedDraft(candidate)}
    />
  );
  const selectedDraftCard = draftCards.find(isSelectedDraft);
  const stars = useSyncExternalStore(starStore.subscribe, starStore.get);
  const starsShown = useSyncExternalStore(starEnabled.subscribe, starEnabled.get);
  // A Star's card stands for its conversation: selected with the Star, or with one of its conversation's subagents.
  const starCard = (star: Star) => {
    const conversation = star.current === null ? undefined : keyOf(star.current);
    return (
      <StarCard
        key={starKey(star.id)}
        star={star}
        environment={chip(star.current?.environmentId ?? star.homes[0]?.environmentId ?? "")}
        subagents={conversation === undefined ? [] : (subagents.get(conversation) ?? [])}
        activities={activities}
        selected={
          selection === starKey(star.id) ||
          (conversation !== undefined && selectedCard === conversation)
        }
        selection={selection}
        now={now}
      />
    );
  };
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
        {starsShown ? stars.map(starCard) : null}
        <ExplorerShelf environments={state.environments} />
        {state.environments.length === 0 ? (
          <li className="pult-panel-empty">
            <p>Not connected.</p>
            <button
              type="button"
              className="pult-panel-button"
              onClick={() => run("pult-shell.connect")}
            >
              Connect to Environment
            </button>
          </li>
        ) : listed.length > 0 || draftCards.length > 0 ? (
          <Shelf
            name="ready"
            label="Ready"
            threads={listed}
            selection={selectedCard}
            render={card}
            initiallyExpanded
            lead={draftCards.map(draftCard)}
            selectedLead={selectedDraftCard === undefined ? null : draftCard(selectedDraftCard)}
          >
            {listed.map(card)}
          </Shelf>
        ) : state.threads.length === 0 ? (
          <li className="pult-panel-empty">
            No threads in {state.environments.map((environment) => environment.label).join(", ")}.
          </li>
        ) : null}
        {working.length > 0 ? (
          <Shelf
            name="working"
            label="Working"
            threads={working}
            selection={selectedCard}
            render={card}
          >
            {working.map(card)}
          </Shelf>
        ) : null}
        {snoozed.length > 0 ? (
          <Shelf
            name="snoozed"
            label="Snoozed"
            threads={snoozed}
            selection={selectedCard}
            render={card}
          >
            {snoozed.map(card)}
          </Shelf>
        ) : null}
        {settled.length > 0 || state.settled.count > 0 ? (
          <Shelf
            name="settled"
            label="Settled"
            threads={settled}
            count={state.settled.count}
            selection={selectedCard}
            render={card}
          >
            <SettledTail
              threads={settled}
              shelf={state.settled}
              selection={selectedCard}
              render={card}
            />
          </Shelf>
        ) : null}
        <LimitsShelf now={now} />
      </ul>
    </div>
  );
}

/**
 * A shelf under its collapsible header with its threads' count (`count`,
 * where it holds more than it lists), Ready's without one: its `lead` (Ready's draft cards) and threads (`children`)
 * while expanded, and while collapsed the selected card alone, the lead's
 * (`selectedLead`) or one of the threads, as upstream's shelves keep the open thread's row,
 * so a thread selected as it starts working stays in view. Whether it is
 * expanded persists in localStorage, per shelf, as upstream keeps its own;
 * collapsed until opened, or `initiallyExpanded`. The shelf after Ready sits
 * at the panel's bottom while the cards leave room (`panel.css`).
 */
function Shelf({
  name,
  label,
  threads,
  count = threads.length,
  selection,
  render,
  initiallyExpanded = false,
  lead = null,
  selectedLead = null,
  children,
}: {
  name: "ready" | "working" | "snoozed" | "settled";
  label: string;
  threads: ReadonlyArray<ShellThread>;
  count?: number;
  selection: string | undefined;
  render: (thread: ShellThread) => React.ReactNode;
  initiallyExpanded?: boolean;
  lead?: React.ReactNode;
  selectedLead?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useExpanded(EXPANDED_KEYS[name], initiallyExpanded);
  const selected = expanded ? undefined : threads.find((thread) => keyOf(thread) === selection);
  return (
    <li className={`pult-shelf pult-shelf-${name}`}>
      <CollapsibleHeader
        label={label}
        count={name === "ready" ? undefined : count}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <ul className="pult-shelf-cards">
          {lead}
          {children}
        </ul>
      ) : selectedLead !== null || selected !== undefined ? (
        <ul className="pult-shelf-cards">
          {selected !== undefined ? render(selected) : selectedLead}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The settled shelf's tail: the first few threads, a page more per "Show
 * more", and the selected thread even when it lies beyond. The shelf holds
 * more than the model lists while the shells leave older settled threads
 * out: the tail tells the model how many it shows, while it is mounted, and
 * the model reads them (`showSettledThreads`), the button reading Loading…
 * meanwhile, or Retry after a failed read.
 */
function SettledTail({
  threads,
  shelf,
  selection,
  render,
}: {
  threads: ReadonlyArray<ShellThread>;
  shelf: ThreadState["settled"];
  selection: string | undefined;
  render: (thread: ShellThread) => React.ReactNode;
}) {
  const [count, setCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  useEffect(() => {
    showSettledThreads(count);
    showingSettled(count);
    return () => {
      showSettledThreads(0);
      showingSettled(SETTLED_TAIL_INITIAL_COUNT);
    };
  }, [count]);
  const visible = settledTail(threads, count, selection);
  const hidden = Math.max(threads.length, shelf.count) - visible.length;
  return (
    <>
      {visible.map(render)}
      {hidden > 0 ? (
        <li className="pult-shelf-more">
          <button
            type="button"
            className="pult-panel-button"
            disabled={shelf.loading}
            onClick={() =>
              shelf.failed ? retrySettledThreads() : setCount(count + SETTLED_TAIL_PAGE_COUNT)
            }
          >
            {shelf.loading
              ? "Loading…"
              : shelf.failed
                ? "Retry"
                : `Show ${Math.min(hidden, SETTLED_TAIL_PAGE_COUNT)} more`}
          </button>
        </li>
      ) : null}
    </>
  );
}

/**
 * T3 Code's thread card without its bottom row: project icon and name, its
 * `environment`'s label beside them while there are several (`EnvironmentChip`),
 * pin, a dot while it is not selected and its composer holds an unsent message, and status, then the title, as the button that selects the thread; on
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
  // The selected thread's composer shows its message itself.
  const unsent =
    useSyncExternalStore(threadsWithUnsentMessages.subscribe, threadsWithUnsentMessages.get).has(
      keyOf(thread),
    ) && !selected;
  useProjectIcons();
  return (
    <li
      className={`pult-card${selected ? " pult-card-selected" : ""}${thread.shelf === "settled" ? " pult-card-settled" : ""}`}
    >
      {/* A button by role, as upstream's card: its actions are buttons inside it. */}
      <div
        role="button"
        tabIndex={0}
        className="pult-card-select"
        aria-current={selected || undefined}
        onClick={select}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
            return;
          event.preventDefault();
          select();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showThreadMenu(thread, { x: event.clientX, y: event.clientY });
        }}
      >
        <span className="pult-card-top">
          <img
            className="pult-card-icon"
            src={projectIconUri(threadProjectIcon(thread)).toString(true)}
            alt=""
          />
          <span className="pult-card-project">{thread.projectName}</span>
          <EnvironmentChip label={environment} />
          {thread.pinned ? (
            <i
              className="codicon codicon-pinned pult-card-pin"
              title="Pinned"
              aria-label="Pinned"
            />
          ) : null}
          {unsent ? (
            <span className="pult-card-unsent" title="Unsent message" aria-label="Unsent message" />
          ) : null}
          <StatusSlot thread={thread} features={features}>
            <Status thread={thread} activity={activities.get(keyOf(thread)) ?? null} now={now} />
          </StatusSlot>
        </span>
        <span className="pult-card-title">{thread.title}</span>
        <JumpHint rowKey={keyOf(thread)} />
      </div>
      {selected && subagents.length > 0 ? (
        <div className="pult-card-details">
          <Subagents
            subagents={subagents}
            activities={activities}
            selection={selection}
            now={now}
          />
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
export function Subagents({
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
  const shown = expanded
    ? subagents
    : subagents.filter((subagent) => keyOf(subagent) === selection);
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
function StatusSlot({
  thread,
  features,
  children,
}: {
  thread: ShellThread;
  features: ThreadFeatures;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const offered = parkActions(thread, features);
  const onCard =
    thread.shelf === "pinned" || thread.shelf === "active" || thread.shelf === "working";
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
      <button
        key="settle"
        type="button"
        title="Settle thread"
        onClick={() => void settleThread(thread)}
      >
        <i className="codicon codicon-check" aria-hidden />
        Settle
      </button>
    ) : null,
    offered.wake ? (
      <button
        key="wake"
        type="button"
        title="Wake thread"
        aria-label="Wake thread"
        onClick={() => wakeThread(thread)}
      >
        <i className="codicon codicon-bell" aria-hidden />
      </button>
    ) : null,
    offered.unsettle ? (
      <button
        key="unsettle"
        type="button"
        title="Un-settle thread"
        aria-label="Un-settle thread"
        onClick={() => unsettleThread(thread)}
      >
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

/** A card's or a subagent's status: the run state when it says something, then Woke, else the thread's age. */
function Status({
  thread,
  activity,
  now,
}: {
  thread: ShellThread;
  activity: Activity;
  now: number;
}) {
  if (activity === "working") {
    return (
      <span className="pult-card-status pult-card-status-working">
        Working{thread.workingSince === null ? null : <Elapsed since={thread.workingSince} />}
      </span>
    );
  }
  if (activity === "waiting")
    return <span className="pult-card-status pult-card-status-waiting">Waiting</span>;
  if (thread.latestRun?.status === "failed")
    return <span className="pult-card-status pult-card-status-failed">Failed</span>;
  if (thread.woke) {
    return (
      <span className="pult-card-status pult-card-status-woke">
        <i className="codicon codicon-bell-dot" aria-hidden /> Woke
      </span>
    );
  }
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
        <i className="codicon codicon-check" aria-hidden />{" "}
        {age(thread.ageFrom ?? thread.updatedAt, now)}
      </span>
    );
  }
  return <span className="pult-card-status">{age(thread.ageFrom ?? thread.updatedAt, now)}</span>;
}

/** The time since `iso`, in T3 Code's short form: `now`, `5m`, `3h`, `2d`. */
export function age(iso: string, now: number): string {
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
export function Elapsed({ since }: { since: string }) {
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
