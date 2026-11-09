import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  commitSha: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  sourceKind: Schema.optionalKey(Schema.Literals(["working-tree", "branch-range"])),
  trackedOnly: Schema.optionalKey(Schema.Boolean),
  metadataOnly: Schema.optionalKey(Schema.Boolean),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      sourceKind: Schema.Literals(["working-tree", "branch-range", "commit"]),
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewBranchCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
});
export type ReviewBranchCommitsInput = typeof ReviewBranchCommitsInput.Type;

export const ReviewBranchCommitsResult = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      committedAt: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});
export type ReviewBranchCommitsResult = typeof ReviewBranchCommitsResult.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals([
  "working-tree",
  "branch-range",
  "commit",
]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  commitSubject: Schema.optionalKey(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  patchesDeferred: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
  incomplete: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

// Pult: a checkout's commit history and its refs, for the shell's Source Control
// Graph (xaxis `pult/issues/scm-history`); a commit's files and their two sides
// are `getDiffPreview` with `commitSha` and `getDiffFileContents` with `commit`.

/** The most commits one page of `review.getLog` holds. */
export const REVIEW_LOG_MAX_LIMIT = 500;

/**
 * A page of the commits reachable from `refs`, in topological order, newest
 * first: `skip` commits of the walk passed over, then at most `limit`.
 */
export const ReviewLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** What the walk starts from, refs or commit shas as `git log` takes them; HEAD when absent or empty. */
  refs: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** The page's cursor: how many commits of the walk come before it. */
  skip: Schema.optional(NonNegativeInt),
  /** Defaults to 50. */
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(REVIEW_LOG_MAX_LIMIT))),
});
export type ReviewLogInput = typeof ReviewLogInput.Type;

export const ReviewLogCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  /** First parent first; none for a root commit. */
  parents: Schema.Array(TrimmedNonEmptyString),
  subject: Schema.String,
  /** The whole message, its subject included. */
  message: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  /** ISO 8601, the author's date. */
  authoredAt: Schema.String,
  /** The full names of the branches, remote branches and tags at the commit (`refs/heads/main`). */
  refs: Schema.Array(TrimmedNonEmptyString),
});
export type ReviewLogCommit = typeof ReviewLogCommit.Type;

export const ReviewLogResult = Schema.Struct({
  commits: Schema.Array(ReviewLogCommit),
  /** Whether the walk goes on past this page. */
  hasMore: Schema.Boolean,
});
export type ReviewLogResult = typeof ReviewLogResult.Type;

export const ReviewRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ReviewRefsInput = typeof ReviewRefsInput.Type;

/** A checkout's HEAD and its branches, remote branches and tags, each with the commit it is at. */
export const ReviewRefsResult = Schema.Struct({
  head: Schema.Struct({
    /** The branch HEAD names (`refs/heads/main`); null when detached. */
    ref: Schema.NullOr(TrimmedNonEmptyString),
    /** Null before the first commit. */
    sha: Schema.NullOr(TrimmedNonEmptyString),
  }),
  /** Symbolic refs (`refs/remotes/origin/HEAD`) left out; a tag at the commit it peels to. */
  refs: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      sha: TrimmedNonEmptyString,
      /** A branch's upstream (`refs/remotes/origin/main`), null when it has none. */
      upstream: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
});
export type ReviewRefsResult = typeof ReviewRefsResult.Type;
