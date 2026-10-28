// How the panel presents threads, after upstream's shelved sidebar
// (`Sidebar.tsx` and `Sidebar.logic.ts` in the fork's web app): its shelves
// and their order, its row status, and the store's flattened threads. Ported
// from pult-extension's `src/threads/presentation.ts` and `src/shellBridge.ts`.
import { type EnvironmentThreadShell, resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { canSnooze, effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { OrchestrationProjectShell } from "@t3tools/contracts";

import { scopedKey, type ShellProject, type ShellThread, type ShelfName, type ThreadFeatures } from "./store.ts";

/**
 * Before the server has said, none of the thread features (`pult/decisions`,
 * `capability-gated-rpcs`). Without settlement or snooze, as on a stock
 * server, no thread sits on those shelves and their actions are hidden, as
 * upstream's sidebar does.
 */
export const NO_THREAD_FEATURES: ThreadFeatures = { settlement: false, snooze: false, pinning: false };

export interface Shelves {
  readonly pinned: ReadonlyArray<EnvironmentThreadShell>;
  readonly active: ReadonlyArray<EnvironmentThreadShell>;
  readonly snoozed: ReadonlyArray<EnvironmentThreadShell>;
  readonly settled: ReadonlyArray<EnvironmentThreadShell>;
}

const SHELF_ORDER: ReadonlyArray<ShelfName> = ["pinned", "active", "snoozed", "settled"];

/** Not archived or deleted: a thread the panel shows, on a shelf or under its root's card. */
function isPresent(thread: EnvironmentThreadShell): boolean {
  return thread.archivedAt === null && thread.deletedAt === null;
}

/** Threads the sidebar lists on its shelves: present, and no subagent's, which live in their parent. */
function isListed(thread: EnvironmentThreadShell): boolean {
  return isPresent(thread) && thread.lineage.relationshipToParent !== "subagent";
}

/**
 * Upstream's shelf for a thread: snooze wins until its wake time, then
 * settlement wins over a stale pin. Null for a thread the sidebar does not list.
 */
export function shelfOf(thread: EnvironmentThreadShell, now: string, features: ThreadFeatures): ShelfName | null {
  if (!isListed(thread)) return null;
  if (features.snooze && effectiveSnoozed(thread, { now })) return "snoozed";
  if (features.settlement && thread.settledOverride === "settled") return "settled";
  return thread.pinnedAt === null ? "active" : "pinned";
}

/**
 * The threads on upstream's shelves (`shelfOf`), each under its own
 * environment's features, every shelf merging the environments as
 * upstream's sidebar does. Pinned and active follow their arranged order,
 * snoozed the soonest wake, settled the newest settlement.
 */
export function shelve(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
  featuresOf: (environmentId: string) => ThreadFeatures,
): Shelves {
  const shelves: Record<ShelfName, Array<EnvironmentThreadShell>> = { pinned: [], active: [], snoozed: [], settled: [] };
  for (const thread of threads) {
    const shelf = shelfOf(thread, now, featuresOf(thread.environmentId));
    if (shelf !== null) shelves[shelf].push(thread);
  }
  const { pinned, active, snoozed, settled } = shelves;
  const wakeMs = (thread: EnvironmentThreadShell) => Date.parse(thread.snoozedUntil ?? "") || 0;
  return {
    pinned: sortPinnedThreadsByOrderKey(pinned),
    active: sortActiveThreadsByOrderKey(active),
    snoozed: snoozed.toSorted((left, right) => wakeMs(left) - wakeMs(right)),
    settled: sortSettledThreads(settled),
  };
}

/** The next time one of `threads` wakes from its snooze, after `now`. */
export function nextWake(threads: ReadonlyArray<EnvironmentThreadShell>, now: number): number | null {
  const wakes = threads.map((thread) => Date.parse(thread.snoozedUntil ?? "")).filter((ms) => ms > now);
  return wakes.length === 0 ? null : Math.min(...wakes);
}

/**
 * R in motion, W waiting on the user, F failed. The sidebar's grey Waiting,
 * an agent stopped with background work that will wake it, is not the user's
 * turn, and counts as in motion: R.
 */
export type StatusBadge = "R" | "W" | "F";

export interface ThreadStatus {
  /** Upstream's label for the status, as its sidebar shows it. */
  readonly label: string;
  readonly badge: StatusBadge | null;
}

/**
 * The shelved sidebar's row status (the fork's `resolveSidebarThreadStatus`,
 * then the row's Woke and Done), with the older pill's Plan Ready between the
 * failures and Woke.
 */
export function threadStatus(thread: EnvironmentThreadShell, now: string): ThreadStatus | null {
  if (thread.hasPendingApprovals) return { label: "Approval", badge: "W" };
  if (thread.hasPendingUserInput) return { label: "Input", badge: "W" };
  switch (thread.runtime?.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      // A native /goal keeps the agent going across turns until it is met.
      return { label: thread.goal?.status === "active" ? "Goal" : "Working", badge: "R" };
    case "idle":
      return { label: "Waiting", badge: "R" };
    case "failed":
      return thread.runtime.lastErrorClass === "usage_limit"
        ? { label: "Limited", badge: "F" }
        : { label: "Failed", badge: "F" };
  }
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan && isLatestRunSettled(thread)) {
    return { label: "Plan Ready", badge: "W" };
  }
  if (isWoke(thread, now)) return { label: "Woke", badge: "W" };
  if (hasUnseenCompletion(thread)) return { label: "Done", badge: null };
  return null;
}

/** Upstream's `isLatestRunSettled` (`session-logic.ts` in the fork's web app). */
function isLatestRunSettled({ latestRun, runtime }: EnvironmentThreadShell): boolean {
  if (latestRun === null) return false;
  switch (latestRun.status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return false;
  }
  return runtime?.activeRunId !== latestRun.runId;
}

/**
 * A snoozed thread that woke and has not been visited since; settling it
 * clears it. An unparseable visit counts as none, so it cannot eat the wake.
 */
function isWoke(thread: EnvironmentThreadShell, now: string): boolean {
  const wokeAt = Date.parse(threadWokeAt(thread, { now }) ?? "");
  if (Number.isNaN(wokeAt) || thread.settledOverride === "settled") return false;
  const visitedAt = Date.parse(thread.lastVisitedAt ?? "");
  return Number.isNaN(visitedAt) || visitedAt < wokeAt;
}

/** A run that completed since the last visit; a thread never visited counts as read. */
function hasUnseenCompletion(thread: EnvironmentThreadShell): boolean {
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  if (Number.isNaN(completedAt) || !thread.lastVisitedAt) return false;
  const visitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(visitedAt) || completedAt > visitedAt;
}

/** A project as the store has it. */
export function shellProject(environmentId: string, project: OrchestrationProjectShell): ShellProject {
  return { environmentId, id: project.id, name: project.title, root: project.workspaceRoot, icon: project.projectIcon ?? null };
}

/** An environment's shell as the model holds it: its presented threads, its projects and its server's features. */
export interface EnvironmentShell {
  readonly environmentId: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly features: ThreadFeatures;
}

/**
 * The store's threads, every environment's: shelf by shelf, as upstream's
 * sidebar lists them (`shelve`), each in its shelf's order across the
 * environments; then the subagents, which upstream lists in their parent and
 * the panel under their root's card, on no shelf. Archived and deleted ones
 * go nowhere.
 */
export function shellThreads(environments: ReadonlyArray<EnvironmentShell>, now: string): Array<ShellThread> {
  const threads = environments.flatMap((environment) => environment.threads);
  const features = new Map(environments.map((environment) => [environment.environmentId, environment.features]));
  const shelves = shelve(threads, now, (environmentId) => features.get(environmentId) ?? NO_THREAD_FEATURES);
  const subagents = threads.filter((thread) => isPresent(thread) && thread.lineage.relationshipToParent === "subagent");
  const byId = new Map(
    environments.flatMap((environment) =>
      environment.projects.map((project) => [scopedKey(environment.environmentId, project.id), project] as const),
    ),
  );
  const present = (thread: EnvironmentThreadShell, shelf: ShelfName | null): ShellThread => {
    const project = byId.get(scopedKey(thread.environmentId, thread.projectId));
    return {
      environmentId: thread.environmentId,
      id: thread.id,
      shelf,
      parentId: thread.lineage.parentThreadId,
      rootId: thread.lineage.rootThreadId,
      projectId: thread.projectId,
      projectName: project?.title ?? thread.projectId,
      projectRoot: project?.workspaceRoot ?? null,
      projectIcon: project?.projectIcon ?? null,
      title: thread.title,
      branch: thread.branch,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      working: threadStatus(thread, now)?.badge === "R",
      waiting: thread.runtime?.status === "idle",
      workingSince: resolveThreadWorkingStartedAt(thread),
      pinned: thread.pinnedAt !== null,
      canSnooze: canSnooze(thread, { now }),
      latestRun:
        thread.latestRun === null
          ? null
          : { status: thread.latestRun.status, startedAt: thread.latestRun.startedAt, finishedAt: thread.latestRun.completedAt },
      goal: thread.goal?.objective ?? null,
    };
  };
  return [
    ...SHELF_ORDER.flatMap((shelf) => shelves[shelf].map((thread) => present(thread, shelf))),
    ...subagents.map((thread) => present(thread, null)),
  ];
}
