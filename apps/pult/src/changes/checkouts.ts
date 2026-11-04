// The changes view's checkouts and what each shows, apart from the workbench
// so `node --test src/changes/checkouts.test.ts` can run it.
import type { ReviewDiffPreviewSource, ReviewDiffPreviewSourceKind } from "@t3tools/contracts";

import { isStarRoot } from "../stars/record.ts";
import type { ShellProject, ShellThread } from "../threads/store.ts";
import { type ChangeType, patchFiles } from "./patch.ts";

/** A working copy the changes view lists: a project's root, or a thread's worktree, on one environment. */
export interface Checkout {
  readonly environmentId: string;
  /** Its host path, the server's `cwd`. */
  readonly root: string;
  readonly projectId: string;
  readonly projectName: string;
  /** A thread's worktree, apart from its project's root, with the branch a thread on it records. */
  readonly worktree: { readonly branch: string | null } | null;
}

/** A checkout's identity across environments. */
export function checkoutKey(environmentId: string, root: string): string {
  return `${environmentId}\n${trimSlash(root)}`;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Every checkout of the held environments, once each: the projects' roots,
 * then the threads' worktrees, in the store's order; a thread whose project
 * the store lists no root for brings its project's root, as it knows it.
 * A Star's folder is none.
 */
export function checkoutsOf(state: {
  readonly projects: ReadonlyArray<Pick<ShellProject, "environmentId" | "id" | "name" | "root">>;
  readonly threads: ReadonlyArray<
    Pick<
      ShellThread,
      "environmentId" | "projectId" | "projectName" | "projectRoot" | "checkoutRoot" | "branch"
    >
  >;
}): Checkout[] {
  const checkouts = new Map<string, Checkout>();
  const add = (checkout: Checkout) => {
    const key = checkoutKey(checkout.environmentId, checkout.root);
    // A Star's folder is no project of the user's (`src/stars/`).
    if (!checkouts.has(key) && !isStarRoot(checkout.root))
      checkouts.set(key, { ...checkout, root: trimSlash(checkout.root) });
  };
  for (const project of state.projects) {
    if (project.root !== null)
      add({
        environmentId: project.environmentId,
        root: project.root,
        projectId: project.id,
        projectName: project.name,
        worktree: null,
      });
  }
  for (const thread of state.threads) {
    const { environmentId, projectId, projectName, projectRoot, checkoutRoot } = thread;
    if (projectRoot !== null)
      add({ environmentId, root: projectRoot, projectId, projectName, worktree: null });
    if (
      checkoutRoot === null ||
      (projectRoot !== null && trimSlash(checkoutRoot) === trimSlash(projectRoot))
    )
      continue;
    add({
      environmentId,
      root: checkoutRoot,
      projectId,
      projectName,
      worktree: { branch: thread.branch },
    });
  }
  return [...checkouts.values()];
}

/** How the Repositories list names a checkout: its project's, a worktree's with its branch, or its folder's name when it records none. */
export function checkoutName(checkout: Checkout): string {
  if (checkout.worktree === null) return checkout.projectName;
  return `${checkout.projectName} · ${checkout.worktree.branch ?? checkout.root.split("/").at(-1) ?? checkout.root}`;
}

/** A changed file of a checkout's source or a thread's turn, with what the server's file contents RPC needs to show its sides. */
export interface Change {
  readonly environmentId: string;
  readonly cwd: string;
  /** A server's diff source, or a turn's, between its checkpoints. */
  readonly sourceKind: ReviewDiffPreviewSourceKind | "turn";
  /** The source's refs, or a turn's checkpoint refs, before and after it. */
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** Relative to `cwd`, after the change. */
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeType;
  readonly additions: number;
  readonly deletions: number;
}

/** A source's files as changes: its stats, with how each changed from its patch; a file the truncated patch missed counts as modified. */
function changesOf(environmentId: string, cwd: string, source: ReviewDiffPreviewSource): Change[] {
  const parsed = new Map(patchFiles(source.diff).map((file) => [file.path, file]));
  const stats =
    source.files ?? [...parsed.values()].map((file) => ({ ...file, additions: 0, deletions: 0 }));
  return stats.map((stat) => {
    const file = parsed.get(stat.path);
    return {
      environmentId,
      cwd,
      sourceKind: source.kind,
      baseRef: source.baseRef,
      headRef: source.headRef,
      path: stat.path,
      previousPath: file?.previousPath ?? stat.previousPath,
      changeType: file?.changeType ?? (stat.previousPath === null ? "change" : "rename-changed"),
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
}

/**
 * The one source a checkout shows, with its changes: the working tree while
 * it has uncommitted changes, else the branch against its base, since the
 * server's branch range repeats the uncommitted ones
 * (`pult/issues/committed-only-branch-diff`), but for a branch whose base is
 * its own upstream, whose range is only its unpushed commits; undefined with
 * neither.
 */
export function shownChanges(
  environmentId: string,
  cwd: string,
  sources: ReadonlyArray<ReviewDiffPreviewSource>,
):
  | { readonly kind: ReviewDiffPreviewSourceKind; readonly changes: ReadonlyArray<Change> }
  | undefined {
  for (const kind of ["working-tree", "branch-range"] as const) {
    const source = sources.find((candidate) => candidate.kind === kind);
    const changes =
      source === undefined || againstOwnUpstream(source)
        ? []
        : changesOf(environmentId, cwd, source);
    if (changes.length > 0) return { kind, changes };
  }
  return undefined;
}

/** Whether a branch range is the branch against itself on a remote (`main` against `origin/main`), as the server picks for the default branch. */
function againstOwnUpstream({ kind, baseRef, headRef }: ReviewDiffPreviewSource): boolean {
  if (kind !== "branch-range" || baseRef === null || headRef === null) return false;
  return baseRef === headRef || baseRef.slice(baseRef.indexOf("/") + 1) === headRef;
}
