// The changes view's checkouts and what each shows, apart from the workbench
// so `node --test src/changes/checkouts.test.ts` can run it.
import type {
  ReviewDiffPreviewSource,
  ReviewDiffPreviewSourceKind,
  VcsStatusXaxis,
} from "@t3tools/contracts";

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
 * A hidden project's, a Star's folder, is none (`src/stars/hidden.ts`).
 */
export function checkoutsOf(
  state: {
    readonly projects: ReadonlyArray<Pick<ShellProject, "environmentId" | "id" | "name" | "root">>;
    readonly threads: ReadonlyArray<
      Pick<
        ShellThread,
        "environmentId" | "projectId" | "projectName" | "projectRoot" | "checkoutRoot" | "branch"
      >
    >;
  },
  hidden: (environmentId: string, projectId: string) => boolean,
): Checkout[] {
  const checkouts = new Map<string, Checkout>();
  const add = (checkout: Checkout) => {
    const key = checkoutKey(checkout.environmentId, checkout.root);
    // A Star's folder is no project of the user's (`src/stars/`).
    if (!checkouts.has(key) && !hidden(checkout.environmentId, checkout.projectId))
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

/**
 * How the Repositories list names a checkout: its project's, a worktree's
 * with its branch, or its folder's name when it records none or is an xaxis
 * copy, whose branch is main like every checkout of its project's
 * (`pult/decisions`, `xaxis-copies`); `xaxis` is whether its status says so.
 */
export function checkoutName(checkout: Checkout, xaxis = false): string {
  if (checkout.worktree === null) return checkout.projectName;
  const folder = checkout.root.split("/").at(-1) ?? checkout.root;
  return `${checkout.projectName} · ${(xaxis ? null : checkout.worktree.branch) ?? folder}`;
}

/** A changed file of a checkout's source or a thread's turn, with what the server's file contents RPC needs to show its sides. */
export interface Change {
  readonly environmentId: string;
  /** The checkout the server reads the change in. */
  readonly cwd: string;
  /** The repository's root, which the server's paths are relative to: the checkout's own, or above it for a project in a subdirectory of its repository. */
  readonly repositoryRoot: string;
  /** A server's diff source, or a turn's, between its checkpoints. */
  readonly sourceKind: ReviewDiffPreviewSourceKind | "turn";
  /** The source's refs, or a turn's checkpoint refs, before and after it. */
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** Relative to `repositoryRoot`, after the change. */
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeType;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * A source's files as changes: its stats, with how each changed from its
 * patch where it names the file (an xaxis checkout's headers, a bounded
 * patch, an older server's), else from the stat; a stat that names none,
 * as a server before upstream's 2026-11-14 sends, counts as modified.
 */
function changesOf(
  environmentId: string,
  cwd: string,
  repositoryRoot: string,
  source: ReviewDiffPreviewSource,
): Change[] {
  const parsed = new Map(patchFiles(source.diff).map((file) => [file.path, file]));
  const stats =
    source.files ?? [...parsed.values()].map((file) => ({ ...file, additions: 0, deletions: 0 }));
  return stats.map((stat) => {
    const file = parsed.get(stat.path);
    return {
      environmentId,
      cwd,
      repositoryRoot,
      sourceKind: source.kind,
      baseRef: source.baseRef,
      headRef: source.headRef,
      path: stat.path,
      previousPath: file?.previousPath ?? stat.previousPath,
      changeType:
        file?.changeType ??
        stat.changeType ??
        (stat.previousPath === null ? "change" : "rename-changed"),
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
}

/**
 * The one source a checkout shows, with its changes: the working tree while
 * it has uncommitted changes, else the branch against its base, since the
 * server's branch range repeats the uncommitted ones
 * (`pult/tasks/committed-only-branch-diff.task`), but for a branch whose base is
 * its own upstream, whose range is only its unpushed commits; undefined with
 * neither.
 */
export function shownChanges(
  environmentId: string,
  cwd: string,
  repositoryRoot: string,
  sources: ReadonlyArray<ReviewDiffPreviewSource>,
):
  | { readonly kind: ReviewDiffPreviewSourceKind; readonly changes: ReadonlyArray<Change> }
  | undefined {
  for (const kind of ["working-tree", "branch-range"] as const) {
    const source = sources.find((candidate) => candidate.kind === kind);
    const changes =
      source === undefined || againstOwnUpstream(source)
        ? []
        : changesOf(environmentId, cwd, repositoryRoot, source);
    if (changes.length > 0) return { kind, changes };
  }
  return undefined;
}

/** Whether a branch range is the branch against itself on a remote (`main` against `origin/main`), as the server picks for the default branch. */
function againstOwnUpstream({ kind, baseRef, headRef }: ReviewDiffPreviewSource): boolean {
  if (kind !== "branch-range" || baseRef === null || headRef === null) return false;
  return baseRef === headRef || baseRef.slice(baseRef.indexOf("/") + 1) === headRef;
}

/** A checkout's shown changes but its xaxis conflict's paths, which the Conflicts group lists instead; the paths are its root's, as the server names both. */
export function withoutConflicts(
  changes: ReadonlyArray<Change>,
  conflicts: VcsStatusXaxis["conflicts"],
): ReadonlyArray<Change> {
  if (conflicts.length === 0) return changes;
  const conflicted = new Set(conflicts.map((conflict) => conflict.path));
  return changes.filter((change) => !conflicted.has(change.path));
}
