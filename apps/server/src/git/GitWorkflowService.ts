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

import { trimAsciiWhitespace } from "@t3tools/contracts";
import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
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
      options?: GitManager.GitLocalStatusOptions,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
        readonly details: GitVcsDriver.GitRemoteStatusDetails;
      } | null,
      GitManagerServiceError
    >;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly readLocalStatusRefSnapshot: GitVcsDriver.GitVcsDriver["Service"]["readLocalStatusRefSnapshot"];
    readonly readRefSnapshot: GitVcsDriver.GitVcsDriver["Service"]["readRefSnapshot"];
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPath: (cwd: string) => Effect.Effect<string | null, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    /** Pult: `vcs.resolveConflict`, a registered kind's checkout's alone (`VcsDriverRegistry.register`). */
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
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
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
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
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
    /**
     * Pult: the base `delegate_task`'s isolated child of a registered kind's checkout starts at, the
     * checkout's head, refused during a conflict; null for a folder of any other kind.
     */
    readonly delegatedCopyBase: (cwd: string) => Effect.Effect<string | null, GitCommandError>;
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
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  // Pult: any kind's handle, which a registered kind's routes take before git's checks.
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

  // Pult: a registered kind's is a checkout (`VcsDriverRegistry.register`).
  const kindName = (handle: VcsDriverRegistry.VcsDriverHandle) =>
    handle.workflow === undefined ? `a ${handle.kind} repository` : `a ${handle.kind} checkout`;

  const noGitWorkflow = (
    operation: string,
    cwd: string,
    handle: VcsDriverRegistry.VcsDriverHandle,
  ) =>
    new GitManagerError({
      operation,
      cwd,
      detail: `This is ${kindName(handle)}, which has no Git workflow.`,
    });

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForWorkflow(operation, cwd);
    // Pult: another kind's checkout runs no git.
    if (handle.kind !== "git") return yield* noGitWorkflow(operation, cwd, handle);
    return handle;
  });

  // Pult: any kind's handle, which a registered kind's routes take before git's checks.
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

  const notGit = (operation: string, cwd: string, handle: VcsDriverRegistry.VcsDriverHandle) =>
    new GitCommandError({
      operation,
      command: "vcs-route",
      cwd,
      reason: "not_a_repository",
      detail: `This is ${kindName(handle)}, not a Git repository.`,
    });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForCommand(operation, cwd);
    // Pult: another kind's checkout runs no git.
    if (handle.kind !== "git") return yield* notGit(operation, cwd, handle);
    return handle;
  });

  // Pult: the registered kind's calls, when a worktree call or a git question asked around one is
  // its checkout's to answer (`pult/decisions`, `monore-copies`); null for git, git's checks for
  // every other kind.
  const workflowFor = Effect.fn("GitWorkflowService.workflowFor")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveForCommand(operation, cwd);
    if (handle.workflow !== undefined) return handle.workflow;
    if (handle.kind !== "git") return yield* notGit(operation, cwd, handle);
    return null;
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
    // Pult: a registered kind's checkout is not a Git repository here.
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
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => (handle?.kind === "git" ? handle.repository.rootPath : null)),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function* (input) {
      // Pult: a registered kind's checkout has no commits by git's names.
      if ((yield* workflowFor("GitWorkflowService.hasCommit", input.cwd)) !== null) return false;
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
            : handle?.workflow !== undefined
              ? Effect.all(
                  [
                    handle.workflow.localStatus(handle.repository.rootPath),
                    handle.workflow.remoteStatus(handle.repository.rootPath),
                  ],
                  { concurrency: "unbounded" },
                ).pipe(Effect.map(([local, remote]) => ({ ...local, ...remote })))
              : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input, options) {
      return detectRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.localStatus(input, options)
            : handle?.workflow !== undefined
              ? handle.workflow.localStatus(handle.repository.rootPath)
              : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      );
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      const handle = yield* detectRepositoryForStatus("GitWorkflowService.currentBranch", cwd);
      // Pult: a registered kind's checkout is on its own line of main, as its status names it.
      if (handle?.workflow !== undefined) return "main";
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
        return trimAsciiWhitespace(result.stdout).replace(/^refs\/heads\//, "") || null;
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
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      const details = yield* git.statusDetailsRemote(cwd, { refreshUpstream: false });
      return details.hasUpstream && details.branch !== null
        ? {
            refName: details.branch,
            aheadCount: details.aheadCount,
            behindCount: details.behindCount,
            details,
          }
        : null;
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((handle) =>
          handle?.kind === "git"
            ? gitManager.remoteStatus(input, options)
            : handle?.workflow !== undefined
              ? handle.workflow.remoteStatus(handle.repository.rootPath)
              : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    readLocalStatusRefSnapshot: git.readLocalStatusRefSnapshot,
    readRefSnapshot: git.readRefSnapshot,
    invalidateStatus: gitManager.invalidateStatus,
    headPath: Effect.fn("GitWorkflowService.headPath")(function* (cwd) {
      // Clients keep watching threads whose worktree was removed; spawning there fails noisily.
      if (!(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))) return null;
      return yield* git
        .execute({
          operation: "GitWorkflowService.headPath",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
          Effect.orElseSucceed(() => null),
        );
    }),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function* (cwd) {
      const operation = "GitWorkflowService.pullCurrentBranch";
      const handle = yield* resolveForCommand(operation, cwd);
      // Pult: a registered kind's checkout's pull is Get latest.
      if (handle.workflow !== undefined) {
        return yield* handle.workflow.getLatest(handle.repository.rootPath);
      }
      if (handle.kind !== "git") return yield* notGit(operation, cwd, handle);
      return yield* git.pullCurrentBranch(cwd);
    }),
    resolveConflict: Effect.fn("GitWorkflowService.resolveConflict")(function* (input) {
      const operation = "GitWorkflowService.resolveConflict";
      const handle = yield* resolveForCommand(operation, input.cwd);
      if (handle.workflow === undefined) {
        return yield* new GitCommandError({
          operation,
          command: "vcs-route",
          cwd: input.cwd,
          detail:
            "Only a monore checkout's conflicts are resolved here; fix a Git conflict by hand.",
        });
      }
      return yield* handle.workflow.resolveConflict(handle.repository.rootPath, input);
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function* (input, options) {
      const handle = yield* resolveForWorkflow("GitWorkflowService.runStackedAction", input.cwd);
      // Pult: a registered kind's checkout commits in its own verbs (`pult/decisions`, `monore-verbs`).
      if (handle.workflow !== undefined) {
        return yield* withCheckoutLease(
          handle.repository.rootPath,
          handle.workflow.runStackedAction(handle.repository.rootPath, input, options),
        );
      }
      if (handle.kind !== "git") {
        return yield* noGitWorkflow("GitWorkflowService.runStackedAction", input.cwd, handle);
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
      // Pult: a registered kind's checkout's worktree is a copy.
      const workflow = yield* workflowFor("GitWorkflowService.createWorktree", input.cwd);
      if (workflow !== null) return yield* workflow.createCopy(input, options?.progress);
      return yield* gitManager.createWorktree(input, options);
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function* (cwd) {
      // Pult: a registered kind's checkout has no branches.
      if ((yield* workflowFor("GitWorkflowService.listLocalBranchNames", cwd)) !== null) return [];
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
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")(
      function (cwd) {
        return ensureGitCommand("GitWorkflowService.resolvePrimaryRemoteName", cwd).pipe(
          Effect.andThen(git.resolvePrimaryRemoteName(cwd)),
        );
      },
    ),
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
        if (
          (yield* workflowFor("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd)) !== null
        ) {
          return null;
        }
        return yield* git.resolveWorktreeBaseRemote(input);
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function* (input) {
        if (
          (yield* workflowFor("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd)) !== null
        ) {
          return null;
        }
        return yield* git.fetchWorktreeBaseCommit(input);
      },
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      function (cwd, remoteName) {
        return ensureGitCommand("GitWorkflowService.resolveDefaultBranchName", cwd).pipe(
          Effect.andThen(git.resolveDefaultBranchName(cwd, remoteName)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function* (input) {
      const workflow = yield* workflowFor("GitWorkflowService.removeWorktree", input.cwd);
      if (workflow !== null) return yield* workflow.removeCopy(input);
      return yield* git.removeWorktree(input);
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function* (input) {
      // Pult: a copy keeps no worktree registry, and no branches below.
      if ((yield* workflowFor("GitWorkflowService.pruneWorktrees", input.cwd)) !== null) return;
      return yield* git.pruneWorktrees(input);
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function* (input) {
      if ((yield* workflowFor("GitWorkflowService.deleteLocalBranch", input.cwd)) !== null) return;
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
    // Pult (`pult/decisions`, `monore-copy-contract`): a folder that resolves to no driver is
    // git's to refuse, as before.
    delegatedCopyBase: Effect.fn("GitWorkflowService.delegatedCopyBase")(function* (cwd) {
      const handle = yield* registry.resolve({ cwd }).pipe(Effect.orElseSucceed(() => null));
      if (handle?.workflow === undefined) return null;
      return yield* handle.workflow.copyBase(cwd);
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
