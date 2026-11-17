import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSetRemoteInput,
  type VcsSetRemoteResult,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsResolveConflictInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as XaxisVcsDriver from "../vcs/XaxisVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    /** Pult: `vcs.resolveConflict`, an xaxis checkout's alone. */
    readonly resolveConflict: (
      input: VcsResolveConflictInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly setRemote: (
      input: VcsSetRemoteInput,
    ) => Effect.Effect<VcsSetRemoteResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const xaxis = yield* XaxisVcsDriver.XaxisVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  // Pult: any kind's handle, which the xaxis routes take before git's checks.
  const resolveForWorkflow = Effect.fn("GitWorkflowService.resolveForWorkflow")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
  });

  const noGitWorkflow = (operation: string, cwd: string, kind: string) =>
    new GitManagerError({
      operation,
      cwd,
      detail: `This is ${kind === "xaxis" ? "an xaxis checkout" : `a ${kind} repository`}, which has no Git workflow.`,
    });

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForWorkflow(operation, cwd);
    // Pult: another kind's checkout, an xaxis one, runs no git.
    if (handle.kind !== "git") return yield* noGitWorkflow(operation, cwd, handle.kind);
    return handle;
  });

  // Pult: any kind's handle, which the xaxis routes take before git's checks.
  const resolveForCommand = Effect.fn("GitWorkflowService.resolveForCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    return yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
  });

  const notGit = (operation: string, cwd: string, kind: string) =>
    new GitCommandError({
      operation,
      command: "vcs-route",
      cwd,
      reason: "not_a_repository",
      detail: `This is ${kind === "xaxis" ? "an xaxis checkout" : `a ${kind} repository`}, not a Git repository.`,
    });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForCommand(operation, cwd);
    // Pult: another kind's checkout, an xaxis one, runs no git.
    if (handle.kind !== "git") return yield* notGit(operation, cwd, handle.kind);
    return handle;
  });

  // Pult: whether a worktree call or a git question asked around one is an xaxis checkout's
  // to answer (`pult/decisions`, `xaxis-copies`), git's checks for every other kind.
  const isXaxisCommand = Effect.fn("GitWorkflowService.isXaxisCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForCommand(operation, cwd);
    if (handle.kind === "xaxis") return true;
    if (handle.kind !== "git") return yield* notGit(operation, cwd, handle.kind);
    return false;
  });

  // Pult: the handle, which callers route by kind; git's routes take `kind === "git"` alone.
  const detectRepositoryForStatus = Effect.fn("GitWorkflowService.detectRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      return handle;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    // Pult: an xaxis checkout is not a Git repository here.
    return handle?.kind === "git";
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    isRepository: Effect.fn("GitWorkflowService.isRepository")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function* (input) {
      // Pult: an xaxis checkout has no commits by git's names.
      if (yield* isXaxisCommand("GitWorkflowService.hasCommit", input.cwd)) return false;
      const result = yield* git.execute({
        operation: "GitWorkflowService.hasCommit",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
        allowNonZeroExit: true,
      });
      return result.exitCode === 0;
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function (input) {
      return detectRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.status(input)
            : handle?.kind === "xaxis"
              ? Effect.all(
                  [
                    xaxis.localStatus(handle.repository.rootPath),
                    xaxis.remoteStatus(handle.repository.rootPath),
                  ],
                  { concurrency: "unbounded" },
                ).pipe(Effect.map(([local, remote]) => ({ ...local, ...remote })))
              : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input) {
      return detectRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.localStatus(input)
            : handle?.kind === "xaxis"
              ? xaxis.localStatus(handle.repository.rootPath)
              : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      );
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      const handle = yield* detectRepositoryForStatus("GitWorkflowService.currentBranch", cwd);
      // Pult: an xaxis checkout is on its own line of main, as its status names it.
      if (handle?.kind === "xaxis") return "main";
      if (handle?.kind !== "git") {
        return null;
      }
      const result = yield* git.execute({
        operation: "GitWorkflowService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
      }
      if (result.exitCode === 1) return null;
      return yield* new GitCommandError({
        operation: "GitWorkflowService.currentBranch",
        command: "git symbolic-ref",
        cwd,
        argumentCount: 3,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        detail: "Failed to read the checked-out branch.",
      });
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.remoteStatus(input, options)
            : handle?.kind === "xaxis"
              ? xaxis.remoteStatus(handle.repository.rootPath)
              : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function* (cwd) {
      const operation = "GitWorkflowService.pullCurrentBranch";
      const handle = yield* resolveForCommand(operation, cwd);
      // Pult: an xaxis checkout's pull is Get latest.
      if (handle.kind === "xaxis") return yield* xaxis.getLatest(handle.repository.rootPath);
      if (handle.kind !== "git") return yield* notGit(operation, cwd, handle.kind);
      return yield* git.pullCurrentBranch(cwd);
    }),
    resolveConflict: Effect.fn("GitWorkflowService.resolveConflict")(function* (input) {
      const operation = "GitWorkflowService.resolveConflict";
      const handle = yield* resolveForCommand(operation, input.cwd);
      if (handle.kind !== "xaxis") {
        return yield* new GitCommandError({
          operation,
          command: "vcs-route",
          cwd: input.cwd,
          detail:
            "Only an xaxis checkout's conflicts are resolved here; fix a Git conflict by hand.",
        });
      }
      return yield* xaxis.resolveConflict(handle.repository.rootPath, input);
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function* (input, options) {
      const handle = yield* resolveForWorkflow("GitWorkflowService.runStackedAction", input.cwd);
      // Pult: an xaxis checkout commits and lands (`pult/decisions`, `xaxis-verbs`).
      if (handle.kind === "xaxis") {
        return yield* withCheckoutLease(
          handle.repository.rootPath,
          xaxis.runStackedAction(handle.repository.rootPath, input, options),
        );
      }
      if (handle.kind !== "git") {
        return yield* noGitWorkflow("GitWorkflowService.runStackedAction", input.cwd, handle.kind);
      }
      return yield* withCheckoutLease(
        handle.repository.rootPath,
        gitManager.runStackedAction(input, options),
      );
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        return ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function* (input, options) {
      // Pult: an xaxis checkout's worktree is a copy.
      if (yield* isXaxisCommand("GitWorkflowService.createWorktree", input.cwd)) {
        return yield* xaxis.createCopy(input, options?.progress);
      }
      return yield* gitManager.createWorktree(input, options);
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function* (cwd) {
      // Pult: an xaxis checkout has no branches.
      if (yield* isXaxisCommand("GitWorkflowService.listLocalBranchNames", cwd)) return [];
      return yield* git.listLocalBranchNames(cwd);
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function* (input) {
        // Pult: a copy has no remote base, so nothing is fetched.
        if (yield* isXaxisCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd)) {
          return null;
        }
        return yield* git.resolveWorktreeBaseRemote(input);
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function* (input) {
        if (yield* isXaxisCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd)) {
          return null;
        }
        return yield* git.fetchWorktreeBaseCommit(input);
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function* (input) {
      if (yield* isXaxisCommand("GitWorkflowService.removeWorktree", input.cwd)) {
        return yield* xaxis.removeCopy(input);
      }
      return yield* git.removeWorktree(input);
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function* (input) {
      // Pult: a copy keeps no worktree registry, and no branches below.
      if (yield* isXaxisCommand("GitWorkflowService.pruneWorktrees", input.cwd)) return;
      return yield* git.pruneWorktrees(input);
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function* (input) {
      if (yield* isXaxisCommand("GitWorkflowService.deleteLocalBranch", input.cwd)) return;
      return yield* git.deleteLocalBranch(input);
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      );
    }),
    setRemote: Effect.fn("GitWorkflowService.setRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.setRemote", input.cwd).pipe(
        Effect.andThen(git.setRemote(input)),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function (input) {
      return ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
