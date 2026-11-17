import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewLogInput,
  type ReviewLogResult,
  type ReviewRefsInput,
  type ReviewRefsResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as XaxisVcsDriver from "../vcs/XaxisVcsDriver.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewLog from "./ReviewLog.ts";

const WORKSPACE_BOUND_SUBJECTS = {
  "ReviewService.getBranchCommits": "commit list",
  "ReviewService.getDiffPreview": "diff preview",
  "ReviewService.getDiffFileContents": "diff file contents",
  "ReviewService.getLog": "commit log",
  "ReviewService.getRefs": "ref list",
} as const;

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    /** Pult: a page of the checkout's commits (`review.getLog`). */
    readonly getLog: (
      input: ReviewLogInput,
    ) => Effect.Effect<ReviewLogResult, ReviewDiffPreviewError>;
    /** Pult: the checkout's HEAD and refs (`review.getRefs`). */
    readonly getRefs: (
      input: ReviewRefsInput,
    ) => Effect.Effect<ReviewRefsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const xaxis = yield* XaxisVcsDriver.XaxisVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: keyof typeof WORKSPACE_BOUND_SUBJECTS,
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: `Review ${WORKSPACE_BOUND_SUBJECTS[operation]} cwd must stay within the configured workspace root.`,
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }
    // Pult: an xaxis checkout's diff from its CLI.
    if (handle.kind === "xaxis") {
      return yield* xaxis.getDiffPreview(handle.repository.rootPath, input);
    }

    return yield* git.getReviewDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    // Pult: an xaxis checkout's sides from its CLI and the disk.
    if (handle?.kind === "xaxis") {
      return yield* xaxis.getDiffFileContents(handle.repository.rootPath, input);
    }
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  // Pult: a checkout's history for the shell's Source Control Graph, Git's or an xaxis checkout's.
  const requireHistory = Effect.fn("ReviewService.requireHistory")(function* (
    operation: "ReviewService.getLog" | "ReviewService.getRefs",
    cwd: string,
  ) {
    yield* assertWorkspaceBoundCwd(operation, cwd);
    const handle = yield* vcsRegistry.detect({ cwd, requestedKind: "auto" });
    if (handle?.kind !== "git" && handle?.kind !== "xaxis") {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle?.kind ?? "unknown",
        detail: "Commit history requires a Git repository or an xaxis checkout.",
      });
    }
    return handle;
  });

  const getLog: ReviewService["Service"]["getLog"] = Effect.fn("ReviewService.getLog")(
    function* (input) {
      const handle = yield* requireHistory("ReviewService.getLog", input.cwd);
      if (handle.kind === "xaxis") return yield* xaxis.getLog(handle.repository.rootPath, input);
      return yield* ReviewLog.getLog(git, input);
    },
  );

  const getRefs: ReviewService["Service"]["getRefs"] = Effect.fn("ReviewService.getRefs")(
    function* (input) {
      const handle = yield* requireHistory("ReviewService.getRefs", input.cwd);
      if (handle.kind === "xaxis") return yield* xaxis.getRefs(handle.repository.rootPath);
      return yield* ReviewLog.getRefs(git, input);
    },
  );

  return ReviewService.of({
    getBranchCommits,
    getDiffPreview,
    getDiffFileContents,
    getLog,
    getRefs,
  });
});

export const layer = Layer.effect(ReviewService, make);
