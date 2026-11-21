// A checkout's branch against its upstream and the action its button offers,
// apart from the workbench so `node --test src/changes/sync.test.ts` can run it.
import type { VcsStatusResult, VcsStatusXaxis } from "@t3tools/contracts";

import type { KeptAnswer, KeptCheckout } from "../stars/plugin.ts";

/** A checkout's branch against its upstream, as the server's status last had it. */
export interface SyncState {
  /** Null on a detached HEAD. */
  readonly branch: string | null;
  readonly hasUpstream: boolean;
  /** An xaxis checkout's: its stack's length, and how far main's tip is past its base. */
  readonly ahead: number;
  readonly behind: number;
  /** An xaxis checkout's own state, its presence naming the kind (`pult/decisions`, `xaxis-status-fields`); null for git's. */
  readonly xaxis: XaxisState | null;
}

/** What an xaxis checkout's status adds: a land's conflict, a write stopped partway, a tip it could not read. */
export interface XaxisState {
  readonly conflicts: VcsStatusXaxis["conflicts"];
  readonly interrupted: VcsStatusXaxis["interrupted"];
  readonly tip: NonNullable<VcsStatusResult["xaxisTip"]> | null;
  /** Why the latest read failed, after one that said xaxis, whose state it keeps; null when it went through. */
  readonly failure: string | null;
}

/** How long a checkout's status stands before a read asks again, since every read fetches its upstream. */
export const SYNC_INTERVAL_MS = 2 * 60_000;

export function syncState(status: VcsStatusResult): SyncState | undefined {
  if (!status.isRepo) return undefined;
  return {
    branch: status.refName,
    hasUpstream: status.hasUpstream,
    ahead: status.aheadCount,
    behind: status.behindCount,
    xaxis:
      status.xaxis === undefined
        ? null
        : {
            conflicts: status.xaxis.conflicts,
            interrupted: status.xaxis.interrupted,
            tip: status.xaxisTip ?? null,
            failure: null,
          },
  };
}

/** A failed read of a checkout last read as xaxis's: its state kept, the failure told (undefined for any other). */
export function failedRead(state: SyncState | undefined, message: string): SyncState | undefined {
  if (state?.xaxis == null) return undefined;
  return { ...state, xaxis: { ...state.xaxis, failure: message } };
}

/**
 * Whether the checkout has commits to pull or push, which keeps it in the
 * view with a clean working tree; an xaxis checkout's conflict or
 * interrupted write too, which Take latest on every path leaves with
 * nothing else to show.
 */
export function hasSync(state: SyncState | undefined): boolean {
  if (state === undefined) return false;
  if (
    state.xaxis !== null &&
    (state.xaxis.conflicts.length > 0 || state.xaxis.interrupted !== null)
  )
    return true;
  return state.hasUpstream && (state.ahead > 0 || state.behind > 0);
}

/**
 * The checkout's action button: Commit while its working tree has changes;
 * else Sync while it has commits to pull or push, or Diverged, disabled,
 * while it has both, which a fast-forward pull refuses; else Publish for a
 * branch with no upstream; else Commit, disabled.
 */
export type SyncAction =
  | { readonly kind: "commit"; readonly enabled: boolean }
  | { readonly kind: "sync" | "diverged"; readonly ahead: number; readonly behind: number }
  | { readonly kind: "publish" }
  | XaxisAction;

/** An xaxis checkout's button, in its own words (xaxis `pult/tasks/xaxis-source-control.task`). */
export interface XaxisAction {
  readonly kind: "commit-land" | "get-latest";
  readonly enabled: boolean;
  readonly title: string;
  readonly tooltip: string;
}

export function syncAction(uncommitted: boolean, state: SyncState | undefined): SyncAction {
  if (state?.xaxis != null) return xaxisAction(uncommitted, state, state.xaxis);
  if (uncommitted) return { kind: "commit", enabled: true };
  if (state !== undefined && hasSync(state)) {
    return {
      kind: state.ahead > 0 && state.behind > 0 ? "diverged" : "sync",
      ahead: state.ahead,
      behind: state.behind,
    };
  }
  if (state !== undefined && !state.hasUpstream && state.branch !== null)
    return { kind: "publish" };
  return { kind: "commit", enabled: false };
}

/** The message box's placeholder on an xaxis checkout, `{0}` the workbench's Accept Input keybinding. */
export const XAXIS_PLACEHOLDER = "Message ({0} to commit and land)";

const COMMIT_LAND = "$(check) Commit & Land";
const COMMIT_EVERYTHING = "Commit every change and land it on main";

/**
 * An xaxis checkout's button: under an interrupted write the verb that
 * finishes it (none in Pult for another command); else Commit & Land
 * while a conflict is pending, which only a commit clears, or while there
 * are uncommitted changes or commits not landed, since a land rebases
 * onto main's tip, behind or not; else Get latest while behind; else
 * Commit & Land, disabled.
 */
function xaxisAction(uncommitted: boolean, state: SyncState, xaxis: XaxisState): XaxisAction {
  const { interrupted } = xaxis;
  const getLatest: XaxisAction = {
    kind: "get-latest",
    enabled: true,
    title: `$(cloud-download) Get latest${state.behind > 0 ? ` ${state.behind}$(arrow-down)` : ""}`,
    tooltip:
      state.behind > 0 ? `Bring ${changes(state.behind)} from main` : "Finish getting the latest",
  };
  if (interrupted === "get-latest") return getLatest;
  if (interrupted === "commit-land")
    return {
      kind: "commit-land",
      enabled: true,
      title: COMMIT_LAND,
      tooltip: "Finish landing on main",
    };
  if (interrupted !== null)
    return {
      kind: "commit-land",
      enabled: false,
      title: COMMIT_LAND,
      tooltip: `A write stopped partway: run \`${interrupted.command}\` in a terminal`,
    };
  if (uncommitted || xaxis.conflicts.length > 0)
    return { kind: "commit-land", enabled: true, title: COMMIT_LAND, tooltip: COMMIT_EVERYTHING };
  if (state.ahead > 0)
    return {
      kind: "commit-land",
      enabled: true,
      title: COMMIT_LAND,
      tooltip: `Land ${commits(state.ahead)} on main`,
    };
  if (state.behind > 0) return getLatest;
  return { kind: "commit-land", enabled: false, title: COMMIT_LAND, tooltip: COMMIT_EVERYTHING };
}

/** One item of an xaxis checkout's state line, and what a click on it does. */
export interface XaxisStateItem {
  readonly title: string;
  readonly tooltip: string;
  readonly click: "open-conflict" | "get-latest" | { readonly openThread: string } | null;
}

/**
 * An xaxis checkout's state line, the provider's status bar commands: the
 * first that holds of its conflict, an interrupted write, uncommitted
 * changes (with how far behind it is), commits not landed, behind, and up
 * to date; beside it a tip it could not read. A failed read says so alone,
 * its counts being stale.
 */
export function xaxisStateLine(
  state: SyncState,
  xaxis: XaxisState,
  uncommitted: number,
): ReadonlyArray<XaxisStateItem> {
  if (xaxis.failure !== null)
    return [{ title: "Could not read the checkout", tooltip: xaxis.failure, click: null }];
  const behind = `Behind by ${state.behind}`;
  const { interrupted } = xaxis;
  const main: XaxisStateItem =
    xaxis.conflicts.length > 0
      ? {
          title: `Conflicts in ${files(xaxis.conflicts.length)}`,
          tooltip: "Fix the markers or keep a side, then Commit & Land",
          click: "open-conflict",
        }
      : interrupted !== null
        ? {
            title: "Interrupted",
            tooltip:
              interrupted === "get-latest"
                ? "A Get latest stopped partway: Get latest finishes it"
                : interrupted === "commit-land"
                  ? "A land stopped partway: Commit & Land finishes it"
                  : `A write stopped partway: run \`${interrupted.command}\` in a terminal`,
            click: null,
          }
        : uncommitted > 0
          ? {
              title: [
                `${uncommitted} uncommitted ${uncommitted === 1 ? "change" : "changes"}`,
                ...(state.behind > 0 ? [behind] : []),
              ].join(" · "),
              tooltip: COMMIT_EVERYTHING,
              click: null,
            }
          : state.ahead > 0
            ? {
                title: `${commits(state.ahead)} not landed`,
                tooltip: `Land ${commits(state.ahead)} on main`,
                click: null,
              }
            : state.behind > 0
              ? {
                  title: behind,
                  tooltip: `Bring ${changes(state.behind)} from main`,
                  click: "get-latest",
                }
              : { title: "Up to date", tooltip: "Nothing to land, nothing to get", click: null };
  const tip: ReadonlyArray<XaxisStateItem> =
    xaxis.tip === "signed-out"
      ? [{ title: "Signed out of xaxis", tooltip: "Run `xaxis login` in a terminal", click: null }]
      : xaxis.tip === "unreachable"
        ? [{ title: "Could not reach xaxis", tooltip: "Main's tip could not be read", click: null }]
        : [];
  return [main, ...tip];
}

/** How long the kept checkout's Get latest runs before the state line calls it stuck. */
export const KEPT_STUCK_MS = 5 * 60_000;

/**
 * What the state line adds for the checkout Pult keeps at main's tip, from
 * the plugin's `xaxis/kept` (`pult/decisions`, `xaxis-kept-checkouts`): Can't
 * keep up to date after a failed Get latest, or while the CLI cannot list the
 * checkouts; Get latest stuck once one has run `KEPT_STUCK_MS`; and an agent
 * working in it, which `xaxis-main-checkout` says should work in a copy.
 */
export function keptStateLine(
  answer: Pick<KeptAnswer, "unlisted">,
  kept: Pick<KeptCheckout, "last" | "running" | "agentThreads"> | undefined,
  now: number,
): ReadonlyArray<XaxisStateItem> {
  const cannot = (tooltip: string): XaxisStateItem => ({
    title: "$(warning) Can't keep up to date",
    tooltip,
    click: null,
  });
  if (answer.unlisted !== null) return [cannot(answer.unlisted)];
  if (kept === undefined) return [];
  const items: Array<XaxisStateItem> = [];
  if (kept.last?.outcome === "failed")
    items.push(cannot(kept.last.message ?? "Pult's Get latest of this checkout failed"));
  const since = kept.running === null ? NaN : Date.parse(kept.running.since);
  if (now - since >= KEPT_STUCK_MS) {
    const time = new Date(since).toTimeString().slice(0, 5);
    items.push({
      title: `Get latest stuck since ${time}`,
      tooltip: `Pult's Get latest of this checkout has not finished since ${time}`,
      click: null,
    });
  }
  const [thread] = kept.agentThreads;
  if (thread !== undefined)
    items.push({
      title: "$(warning) An agent is working in this checkout",
      tooltip:
        kept.agentThreads.length === 1
          ? "Pult keeps this checkout at main's tip while the agent works: open its thread"
          : `${kept.agentThreads.length} agents work here while Pult keeps it at main's tip: open the first one's thread`,
      click: { openThread: thread },
    });
  return items;
}

function files(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function changes(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

/** The Sync or Diverged button's title, with its counts as VS Code's git extension writes them. */
export function syncTitle(kind: "sync" | "diverged", ahead: number, behind: number): string {
  const counts = [
    behind > 0 ? `${behind}$(arrow-down)` : "",
    ahead > 0 ? `${ahead}$(arrow-up)` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${kind === "sync" ? "$(sync) Sync Changes" : "$(git-compare) Diverged"} ${counts}`.trim();
}

/** What the Sync button does, in words. */
export function syncTooltip(ahead: number, behind: number): string {
  const steps = [
    behind > 0 ? `pull ${commits(behind)}` : "",
    ahead > 0 ? `push ${commits(ahead)}` : "",
  ]
    .filter(Boolean)
    .join(", then ");
  return steps.charAt(0).toUpperCase() + steps.slice(1);
}

function commits(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

/** What a sync runs, in order: a pull while behind, then a push while ahead. */
export function syncSteps(state: SyncState): ReadonlyArray<"pull" | "push"> {
  return [
    ...(state.behind > 0 ? (["pull"] as const) : []),
    ...(state.ahead > 0 ? (["push"] as const) : []),
  ];
}

/**
 * The state after a step went through, ahead of the status read that
 * confirms it, which fetches and so comes a moment later: a commit one more
 * ahead, a push none ahead with an upstream, a pull none behind.
 */
export function afterStep(
  state: SyncState | undefined,
  step: "commit" | "push" | "pull",
): SyncState | undefined {
  if (state === undefined) return undefined;
  switch (step) {
    case "commit":
      return state.hasUpstream ? { ...state, ahead: state.ahead + 1 } : state;
    case "push":
      return { ...state, hasUpstream: true, ahead: 0 };
    case "pull":
      return { ...state, behind: 0 };
  }
}

/** Why a pull failed: a branch both ahead and behind cannot fast-forward, which the server's message does not say. */
export function pullFailure(state: SyncState | undefined, message: string): string {
  // An xaxis checkout's refusal says why itself.
  if (state !== undefined && state.xaxis === null && state.ahead > 0 && state.behind > 0) {
    return `"${state.branch ?? "HEAD"}" has diverged from its upstream (${commits(state.ahead)} ahead, ${state.behind} behind); merge or rebase it in a terminal.`;
  }
  return message;
}
