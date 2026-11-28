// Pult: the calls `GitWorkflowService` and `ReviewService` route to a VCS kind a plugin registers
// (`VcsDriverRegistry.register`, docs/internals/plugins.md, Hook points). A registered kind's
// checkout is on one line, `main`, with no git refs, branches or remote base, so the services answer
// those questions themselves; everything that does work is here.
import type * as Effect from "effect/Effect";

import type {
  GitCommandError,
  GitManagerServiceError,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  ReviewLogInput,
  ReviewLogResult,
  ReviewRefsResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  VcsResolveConflictInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
} from "@t3tools/contracts";

import type * as GitManager from "../git/GitManager.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";

/** What a settle did with a thread's copy: removed it, or kept it and why. */
export type SettledCopy =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: string };

export interface VcsWorkflow {
  /** `vcsRefreshStatus`'s local part, for the checkout at `root`. */
  readonly localStatus: (root: string) => Effect.Effect<VcsStatusLocalResult, GitCommandError>;
  /** `vcsRefreshStatus`'s remote part. */
  readonly remoteStatus: (root: string) => Effect.Effect<VcsStatusRemoteResult, GitCommandError>;
  readonly getDiffPreview: (
    root: string,
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
  readonly getDiffFileContents: (
    root: string,
    input: ReviewDiffFileContentsInput,
  ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
  readonly getLog: (
    root: string,
    input: ReviewLogInput,
  ) => Effect.Effect<ReviewLogResult, GitCommandError>;
  readonly getRefs: (root: string) => Effect.Effect<ReviewRefsResult, GitCommandError>;
  /** `vcsPull`: the checkout moved to its line's tip. */
  readonly getLatest: (root: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  /** `gitRunStackedAction`: `commit`, `push` and `commit_push` in the kind's own verbs. */
  readonly runStackedAction: (
    root: string,
    input: GitRunStackedActionInput,
    options?: GitManager.GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  /** `vcs.resolveConflict`: one side of conflicted paths, taken whole. */
  readonly resolveConflict: (
    root: string,
    input: VcsResolveConflictInput,
  ) => Effect.Effect<void, GitCommandError>;
  /** `vcs.createWorktree` for a checkout's root: a thread's copy of it. */
  readonly createCopy: (
    input: VcsCreateWorktreeInput,
    progress?: GitVcsDriver.CreateWorktreeProgress,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  /** `vcs.removeWorktree` of a copy: `force` lets uncommitted edits go. */
  readonly removeCopy: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  /** The base `delegate_task`'s isolated child of the checkout at `cwd` starts at. */
  readonly copyBase: (cwd: string) => Effect.Effect<string, GitCommandError>;
  /**
   * At a thread's settle, its copy at `path`, a copy of the checkout at `cwd`, removed unless a
   * thread of `activeThreadIds` is still on it or it holds work.
   */
  readonly cleanSettledCopy: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly activeThreadIds: ReadonlyArray<string>;
  }) => Effect.Effect<SettledCopy>;
}
