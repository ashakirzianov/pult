// A checkout's branch against its upstream and the action its button offers,
// apart from the workbench so `node --test src/changes/sync.test.ts` can run it.
import type { VcsStatusResult } from "@t3tools/contracts";

/** A checkout's branch against its upstream, as the server's status last had it. */
export interface SyncState {
  /** Null on a detached HEAD. */
  readonly branch: string | null;
  readonly hasUpstream: boolean;
  readonly ahead: number;
  readonly behind: number;
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
  };
}

/** Whether the checkout has commits to pull or push, which keeps it in the view with a clean working tree. */
export function hasSync(state: SyncState | undefined): boolean {
  return state !== undefined && state.hasUpstream && (state.ahead > 0 || state.behind > 0);
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
  | { readonly kind: "publish" };

export function syncAction(uncommitted: boolean, state: SyncState | undefined): SyncAction {
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
  if (state !== undefined && state.ahead > 0 && state.behind > 0) {
    return `"${state.branch ?? "HEAD"}" has diverged from its upstream (${commits(state.ahead)} ahead, ${state.behind} behind); merge or rebase it in a terminal.`;
  }
  return message;
}
