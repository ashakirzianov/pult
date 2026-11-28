// Pult: a monore checkout's source control through the `monore` CLI, answering the RPCs the
// changes view and the Graph already call (`pult/decisions`, `monore-source-control-home`).
// A checkout is known by its `.monore-checkout` marker, so detection runs no process.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";

import {
  GitCommandError,
  GitManagerError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type GitActionProgressEvent,
  type GitActionProgressPhase,
  type GitManagerServiceError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ReviewLogCommit,
  type ReviewLogInput,
  type ReviewLogResult,
  type ReviewRefsResult,
  type VcsPullResult,
  type VcsRepositoryIdentity,
  type VcsResolveConflictInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusMonore,
} from "@t3tools/contracts";

import type * as GitManager from "../git/GitManager.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as MonoreCli from "./MonoreCli.ts";
import * as MonoreCopies from "./MonoreCopies.ts";

export const MONORE_MARKER = ".monore-checkout";
/** A checkout's id, as the CLI writes it into the marker. */
const CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The branch and remote branch a monore checkout shows as: its own line, and main's tip. */
export const MONORE_HEAD_REF = "refs/heads/main";
export const MONORE_TIP_REF = "refs/remotes/monore/main";

const DEFAULT_LOG_LIMIT = 50;
/** How far down a checkout's own log a changeset not on main is looked for. */
const OWN_LOG_SEARCH = 100;
const FILE_CONTENTS_MAX_BYTES = 1_000_000;

/** The tip's refusals that mean the CLI's login does not hold, and that the server cannot be reached. */
const SIGNED_OUT_CODES = new Set([
  "no-key",
  "signed-out",
  "sign-in",
  "no-keychain",
  "keychain",
  "unauthenticated",
  "invalid-token",
]);
const UNREACHABLE_CODES = new Set(["unreachable"]);

function todo(reason: string): never {
  throw new Error(`todo: ${reason}`);
}

/** A `sha256:` hash by the seven hex digits after its prefix, as a commit's title shows it. */
function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 7);
}

/** The verb that finishes a write the CLI names by its command. */
function interruptedVerb(command: string | null): VcsStatusMonore["interrupted"] {
  if (command === null) return null;
  if (command === "monore goto") return "get-latest";
  if (command === "monore land") return "commit-land";
  return { command };
}

/** A patch's files, each with its `+` and `-` lines counted, `Binary files … differ` counting none. */
function patchFileStats(patch: string): ReviewDiffFileStat[] {
  const files: Array<{ path: string; previousPath: null; additions: number; deletions: number }> =
    [];
  let current: (typeof files)[number] | undefined;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>`, the two paths one, since monore has no renames.
      const rest = line.slice("diff --git ".length);
      const path = rest.slice(2, 2 + (rest.length - 5) / 2);
      current = { path, previousPath: null, additions: 0, deletions: 0 };
      files.push(current);
      inHunk = false;
    } else if (current === undefined) {
      continue;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      current.additions++;
    } else if (inHunk && line.startsWith("-")) {
      current.deletions++;
    }
  }
  return files;
}

/** A patch's headers alone, its hunks dropped. */
function patchHeaders(patch: string): string {
  let kept = "";
  let inHunk = false;
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    if (!inHunk) kept += line;
  }
  return kept;
}

/** `Name <id>`, the one author string a monore record keeps. */
function splitAuthor(author: string): { readonly name: string; readonly email: string } {
  const match = /^(.*?)\s*<([^>]*)>$/.exec(author);
  return match === null ? { name: author, email: "" } : { name: match[1]!, email: match[2]! };
}

const nowFreshness = Effect.gen(function* () {
  return {
    source: "live-local" as const,
    observedAt: yield* DateTime.now,
    expiresAt: Option.none(),
  };
});

/**
 * The nearest folder from `cwd` upward holding `.monore-checkout` (a file whose
 * content is a checkout's id) or `.git`, and which: a monore checkout inside a
 * git repository is monore's, a repository inside a checkout git's (`pult/decisions`,
 * `vcs-detection-nearest`). Both in one folder fails; null with neither.
 */
export const nearestRepositoryMarker = Effect.fn("MonoreVcsDriver.nearestRepositoryMarker")(
  function* (cwd: string, options?: { readonly monoreOnly?: boolean }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (detail: string, cause?: unknown) =>
      new VcsRepositoryDetectionError({
        operation: "MonoreVcsDriver.nearestRepositoryMarker",
        cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const isMarker = Effect.fn("MonoreVcsDriver.isMarker")(
      function* (folder: string) {
        const marker = path.join(folder, MONORE_MARKER);
        const info = yield* fileSystem.stat(marker).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return false;
        const text = yield* fileSystem.readFileString(marker);
        return CHECKOUT_ID.test(text.trim());
      },
      Effect.mapError((cause) => fail("Could not read a .monore-checkout marker.", cause)),
    );
    let folder = path.resolve(cwd);
    while (true) {
      const [monore, git] = yield* Effect.all([
        isMarker(folder),
        options?.monoreOnly
          ? Effect.succeed(false)
          : fileSystem
              .exists(path.join(folder, ".git"))
              .pipe(Effect.mapError((cause) => fail("Could not inspect a .git entry.", cause))),
      ]);
      if (monore && git) {
        return yield* fail(
          `${folder} holds both a .monore-checkout marker and .git; remove one of them.`,
        );
      }
      if (monore) {
        // Real, as git's toplevel is, so one checkout keys one queue of commands.
        const root = yield* fileSystem
          .realPath(folder)
          .pipe(Effect.mapError((cause) => fail("Could not resolve the checkout's root.", cause)));
        return { kind: "monore" as const, root };
      }
      if (git) return { kind: "git" as const, root: folder };
      const parent = path.dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  },
);

/**
 * The registry's monore driver: detection by the marker, no remotes (so no source
 * control provider attaches), and none of git's process-level operations. The source
 * control itself is `MonoreVcsDriver`.
 */
export const makeVcsDriver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const unsupported = (operation: string, detail: string) =>
    new VcsUnsupportedOperationError({
      operation: `MonoreVcsDriver.${operation}`,
      kind: "monore",
      detail,
    });
  const noCheckpoints = () =>
    Effect.fail(unsupported("checkpoints", "A monore checkout keeps no turn checkpoints yet."));

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = (cwd) =>
    provide(nearestRepositoryMarker(cwd, { monoreOnly: true })).pipe(
      Effect.flatMap((found) =>
        found === null
          ? Effect.succeed(null)
          : nowFreshness.pipe(
              Effect.map((freshness): VcsRepositoryIdentity => ({
                kind: "monore",
                rootPath: found.root,
                metadataPath: path.join(found.root, MONORE_MARKER),
                freshness,
              })),
            ),
      ),
    );

  return VcsDriver.VcsDriver.of({
    execute: Effect.fn("MonoreVcsDriver.execute")(function* () {
      return yield* unsupported(
        "execute",
        "A monore checkout's CLI runs through MonoreVcsDriver alone.",
      );
    }),
    checkpoints: {
      resolveCleanHead: noCheckpoints,
      captureCheckpoint: noCheckpoints,
      captureHeadCheckpoint: noCheckpoints,
      hasCheckpointRef: noCheckpoints,
      restoreCheckpoint: noCheckpoints,
      diffCheckpoints: noCheckpoints,
      listAuthoredPaths: noCheckpoints,
      deleteCheckpointRefs: noCheckpoints,
    },
    detectRepository,
    isInsideWorkTree: Effect.fn("MonoreVcsDriver.isInsideWorkTree")(function* (cwd) {
      return (yield* detectRepository(cwd)) !== null;
    }),
    listWorkspaceFiles: Effect.fn("MonoreVcsDriver.listWorkspaceFiles")(function* () {
      return yield* unsupported(
        "listWorkspaceFiles",
        "A monore checkout lists no workspace files yet.",
      );
    }),
    listRemotes: Effect.fn("MonoreVcsDriver.listRemotes")(function* () {
      return { remotes: [], freshness: yield* nowFreshness };
    }),
    filterIgnoredPaths: Effect.fn("MonoreVcsDriver.filterIgnoredPaths")(function* () {
      return yield* unsupported(
        "filterIgnoredPaths",
        "A monore checkout filters no ignored paths yet.",
      );
    }),
    initRepository: Effect.fn("MonoreVcsDriver.initRepository")(function* () {
      return yield* unsupported(
        "initRepository",
        "Pult does not make monore checkouts yet: run `monore checkout`.",
      );
    }),
  });
});

interface TipRead {
  readonly tip: string;
  readonly base: string;
  readonly behind: number;
}

/** A tip the CLI could not read for its login or its server, which the status names instead of failing. */
class MonoreTipUnread extends Schema.TaggedError<MonoreTipUnread>()("MonoreTipUnread", {
  reason: Schema.Literals(["signed-out", "unreachable"]),
}) {}

function tipUnread(error: MonoreCli.MonoreCliError): MonoreTipUnread | GitCommandError {
  if (error._tag !== "MonoreRefusal") return error;
  if (SIGNED_OUT_CODES.has(error.code)) return new MonoreTipUnread({ reason: "signed-out" });
  if (UNREACHABLE_CODES.has(error.code)) return new MonoreTipUnread({ reason: "unreachable" });
  return error.toCommandError();
}

type TipAnswer =
  | { readonly tip: TipRead }
  | { readonly unread: NonNullable<VcsStatusRemoteResult["monoreTip"]> };

export class MonoreVcsDriver extends Context.Service<
  MonoreVcsDriver,
  {
    /** `vcsRefreshStatus`'s local part, for the checkout at `root`. */
    readonly localStatus: (root: string) => Effect.Effect<VcsStatusLocalResult, GitCommandError>;
    /** `vcsRefreshStatus`'s remote part: the tip read, which `getLog` and `getRefs` then show. */
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
    /** `vcsPull`: Get latest, the checkout moved to main's tip; a refusal keeps its code (`MonoreCli.refusalCode`). */
    readonly getLatest: (root: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    /** This machine's checkouts, as the CLI's registry lists them; `cwd` is where the CLI runs. */
    readonly checkouts: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<MonoreCli.MonoreCheckout>, GitCommandError>;
    /** `gitRunStackedAction`: `commit` commits, `push` lands, `commit_push` is Commit & Land. */
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
    /** `vcs.createWorktree` for a checkout's root: a thread's copy (`MonoreCopies`). */
    readonly createCopy: MonoreCopies.MonoreCopies["create"];
    /** Whether a checkout's root gets a copy (`MonoreCopies`). */
    readonly canCopy: MonoreCopies.MonoreCopies["canCopy"];
    /** `vcs.removeWorktree` of a copy (`MonoreCopies`). */
    readonly removeCopy: MonoreCopies.MonoreCopies["remove"];
    /** The base of `delegate_task`'s isolated child of a checkout (`MonoreCopies`). */
    readonly copyBase: MonoreCopies.MonoreCopies["base"];
    /** A settled thread's copy, removed unless it holds work (`MonoreCopies`). */
    readonly cleanSettledCopy: MonoreCopies.MonoreCopies["cleanSettled"];
  }
>()("t3/vcs/MonoreVcsDriver") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const digest = yield* Digest.Digest;
  const settings = yield* ServerSettings.ServerSettingsService;
  const cli = MonoreCli.make(
    vcsProcess,
    settings.getSettings.pipe(
      Effect.map((current) => current.monoreBinaryPath),
      // Unreadable settings leave the CLI on PATH, as the default does.
      Effect.orElseSucceed(() => ""),
    ),
  );
  const hashDiff = (root: string, diff: string, files: ReadonlyArray<ReviewDiffFileStat>) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(JSON.stringify([diff, files]))).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "MonoreVcsDriver.hashDiff",
            command: "crypto.digest SHA-256",
            cwd: root,
            detail: "Failed to hash review diff.",
            cause,
          }),
      ),
    );
  /** The last tip read per checkout, against the base it was read at. */
  const tips = new Map<string, TipRead>();
  /**
   * One write verb per checkout at a time: the CLI's own lock refuses `checkout-busy` rather than
   * wait, and a verb's status reads around its write must see that write alone.
   */
  const writeLocks = yield* KeyedLock.make<string>();

  const refused = (error: MonoreCli.MonoreCliError) =>
    error._tag === "MonoreRefusal" ? error.toCommandError() : error;
  const status = (
    operation: string,
    root: string,
  ): Effect.Effect<MonoreCli.MonoreStatus, GitCommandError> =>
    cli
      .json({ operation, cwd: root, args: ["status", "--json"] }, MonoreCli.MonoreStatus)
      .pipe(Effect.mapError(refused));
  const diff = (operation: string, root: string, args: ReadonlyArray<string>) =>
    cli.run({ operation, cwd: root, args: ["diff", ...args] }).pipe(Effect.mapError(refused));
  const log = (
    operation: string,
    root: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<MonoreCli.MonoreLog, MonoreCli.MonoreCliError> =>
    cli.json({ operation, cwd: root, args: ["log", "--json", ...args] }, MonoreCli.MonoreLog);
  /** The tip read last, while the checkout's base is still the one it was read at. */
  const lastTip = (root: string, base: string) => {
    const read = tips.get(root);
    return read !== undefined && read.base === base ? read : { tip: base, base, behind: 0 };
  };

  const localStatus: MonoreVcsDriver["Service"]["localStatus"] = Effect.fn(
    "MonoreVcsDriver.localStatus",
  )(function* (root) {
    const read = yield* status("MonoreVcsDriver.localStatus", root);
    const [edits, stack] = yield* Effect.all(
      [
        diff("MonoreVcsDriver.localStatus.diff", root, []),
        read.stack.length === 0
          ? Effect.succeed(null)
          : diff("MonoreVcsDriver.localStatus.stack", root, [read.base, read.head]),
      ],
      { concurrency: "unbounded" },
    );
    const counted = new Map(patchFileStats(edits.stdout).map((file) => [file.path, file]));
    const files = read.changes.map((change) => ({
      path: change.path,
      insertions: counted.get(change.path)?.additions ?? 0,
      deletions: counted.get(change.path)?.deletions ?? 0,
    }));
    const stackFiles = stack === null ? [] : patchFileStats(stack.stdout);
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: true,
      refName: "main",
      headSha: read.head,
      hasWorkingTreeChanges: read.changes.length > 0,
      workingTree: {
        rootPath: read.dir,
        files,
        insertions: files.reduce((sum, file) => sum + file.insertions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      },
      ...(stack === null
        ? {}
        : {
            branchChanges: {
              baseRef: read.base,
              insertions: stackFiles.reduce((sum, file) => sum + file.additions, 0),
              deletions: stackFiles.reduce((sum, file) => sum + file.deletions, 0),
            },
          }),
      monore: {
        conflicts: (read.conflict?.paths ?? []).map(({ path, markers }) => ({ path, markers })),
        interrupted: interruptedVerb(read.interrupted),
      },
    } satisfies VcsStatusLocalResult;
  });

  const remoteStatus: MonoreVcsDriver["Service"]["remoteStatus"] = Effect.fn(
    "MonoreVcsDriver.remoteStatus",
  )(function* (root) {
    // The tip is monore's fetch: read on the broadcaster's cadence, whatever its upstream refresh says.
    const readTip = cli
      .json(
        { operation: "MonoreVcsDriver.remoteStatus", cwd: root, args: ["tip", "--json"] },
        MonoreCli.MonoreTip,
      )
      .pipe(
        Effect.map((tip): TipAnswer => ({ tip })),
        Effect.mapError(tipUnread),
        Effect.catchTags({
          MonoreTipUnread: (unread) => Effect.succeed<TipAnswer>({ unread: unread.reason }),
        }),
      );
    const [read, tip] = yield* Effect.all(
      [status("MonoreVcsDriver.remoteStatus.status", root), readTip],
      { concurrency: "unbounded" },
    );
    if ("tip" in tip) tips.set(root, tip.tip);
    return {
      hasUpstream: true,
      aheadCount: read.stack.length,
      behindCount: "tip" in tip ? tip.tip.behind : 0,
      pr: null,
      ...("unread" in tip ? { monoreTip: tip.unread } : {}),
    } satisfies VcsStatusRemoteResult;
  });

  /** A changeset's record: in the checkout's own log, else on main's line. */
  const findChangeset = Effect.fn("MonoreVcsDriver.findChangeset")(function* (
    root: string,
    hash: string,
  ) {
    const own = yield* log("MonoreVcsDriver.findChangeset.own", root, [
      "-n",
      String(OWN_LOG_SEARCH),
    ]).pipe(Effect.mapError(refused));
    const found = own.changesets.find((changeset) => changeset.hash === hash);
    if (found !== undefined) return found;
    const onMain = yield* log("MonoreVcsDriver.findChangeset.main", root, [
      "--from",
      hash,
      "-n",
      "1",
    ]).pipe(
      Effect.catchTags({ MonoreRefusal: () => Effect.succeed({ changesets: [] }) }),
      Effect.mapError(refused),
    );
    const record = onMain.changesets[0];
    if (record?.hash === hash) return record;
    return yield* new GitCommandError({
      operation: "MonoreVcsDriver.findChangeset",
      command: "monore log",
      cwd: root,
      detail: "Selected commit is invalid or no longer available.",
    });
  });

  const getDiffPreview: MonoreVcsDriver["Service"]["getDiffPreview"] = Effect.fn(
    "MonoreVcsDriver.getDiffPreview",
  )(function* (root, input) {
    // Stock clients send `ignoreWhitespace` and `trackedOnly`: the CLI's diff keeps whitespace,
    // and its preview is always complete, as an older server's answer to `trackedOnly` is.
    if (input.baseRef !== undefined) {
      return yield* new GitCommandError({
        operation: "MonoreVcsDriver.getDiffPreview",
        command: "monore diff",
        cwd: root,
        detail: "A monore checkout's changes compare against its base alone.",
      });
    }
    const sourceKind = input.file?.sourceKind ?? input.sourceKind;
    const paths = input.file === undefined ? [] : ["--", input.file.path];
    const deferred = input.metadataOnly === true && input.file === undefined;
    const source = Effect.fn("MonoreVcsDriver.getDiffPreview.source")(function* (
      fields: Omit<ReviewDiffPreviewSource, "diff" | "diffHash" | "files" | "truncated">,
      patch: VcsProcess.VcsProcessOutput,
    ) {
      const files = patchFileStats(patch.stdout);
      const diff = deferred ? patchHeaders(patch.stdout) : patch.stdout;
      return {
        ...fields,
        diff,
        files,
        diffHash: yield* hashDiff(root, diff, files),
        truncated: patch.stdoutTruncated,
        ...(deferred ? { patchesDeferred: true } : {}),
      } satisfies ReviewDiffPreviewSource;
    });
    const result = (sources: ReadonlyArray<ReviewDiffPreviewSource>) =>
      DateTime.now.pipe(
        Effect.map((generatedAt): ReviewDiffPreviewResult => ({
          cwd: input.cwd,
          generatedAt,
          sources,
        })),
      );

    if (input.commitSha !== undefined || sourceKind === "commit") {
      if (input.commitSha === undefined) {
        return yield* new GitCommandError({
          operation: "MonoreVcsDriver.getDiffPreview",
          command: "monore diff",
          cwd: root,
          detail: "Selected commit request is invalid.",
        });
      }
      const changeset = yield* findChangeset(root, input.commitSha);
      const parent = changeset.parents[0];
      if (parent === undefined) todo("a monore changeset with no parent");
      const patch = yield* diff("MonoreVcsDriver.getDiffPreview.commit", root, [
        parent,
        changeset.hash,
        ...paths,
      ]);
      const subject = changeset.message.split("\n", 1)[0]!.trim();
      return yield* result([
        yield* source(
          {
            id: changeset.hash,
            kind: "commit",
            title: `Commit ${shortHash(changeset.hash)}`,
            ...(subject === "" ? {} : { commitSubject: subject }),
            baseRef: parent,
            headRef: changeset.hash,
          },
          patch,
        ),
      ]);
    }

    const read = yield* status("MonoreVcsDriver.getDiffPreview.status", root);
    const [edits, stack] = yield* Effect.all(
      [
        sourceKind === "branch-range"
          ? Effect.succeed(null)
          : diff("MonoreVcsDriver.getDiffPreview.workingTree", root, paths),
        sourceKind === "working-tree" || read.stack.length === 0
          ? Effect.succeed(null)
          : diff("MonoreVcsDriver.getDiffPreview.stack", root, [read.base, read.head, ...paths]),
      ],
      { concurrency: "unbounded" },
    );
    const sources: ReviewDiffPreviewSource[] = [];
    if (edits !== null) {
      sources.push(
        yield* source(
          {
            id: "working-tree",
            kind: "working-tree",
            title: "Uncommitted",
            baseRef: read.head,
            headRef: null,
          },
          edits,
        ),
      );
    }
    if (stack !== null) {
      sources.push(
        yield* source(
          {
            id: "branch-range",
            kind: "branch-range",
            title: "Changes",
            baseRef: read.base,
            headRef: read.head,
          },
          stack,
        ),
      );
    }
    return yield* result(sources);
  });

  const fileError = (root: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: "MonoreVcsDriver.getDiffFileContents",
      command: "monore show",
      cwd: root,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** A file's bytes at a changeset as text, "" where there is no file. */
  const showFile = (root: string, hash: string, relativePath: string) =>
    cli
      .run({
        operation: "MonoreVcsDriver.getDiffFileContents.show",
        cwd: root,
        args: ["show", hash, relativePath],
      })
      .pipe(
        Effect.flatMap((result) =>
          result.stdout.includes("\0") || result.stdoutInvalidUtf8
            ? Effect.fail(fileError(root, `Cannot expand binary file '${relativePath}'.`))
            : Effect.succeed(result.stdout),
        ),
        Effect.catchTags({
          MonoreRefusal: (refusal) =>
            refusal.code === "no-such-path" ? Effect.succeed("") : Effect.fail(refused(refusal)),
        }),
      );

  const diskFile = Effect.fn("MonoreVcsDriver.diskFile")(function* (
    root: string,
    relativePath: string,
  ) {
    const requested = path.resolve(root, relativePath);
    const within = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    };
    if (!within(root, requested)) {
      return yield* fileError(root, `Diff file '${relativePath}' resolves outside the checkout.`);
    }
    const [realRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(root),
      fileSystem.realPath(requested),
    ]).pipe(
      Effect.mapError((cause) =>
        fileError(root, `Could not resolve diff file '${relativePath}'.`, cause),
      ),
    );
    if (!within(realRoot, realTarget)) {
      return yield* fileError(root, `Diff file '${relativePath}' resolves outside the checkout.`);
    }
    const info = yield* fileSystem
      .stat(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError(root, `Could not inspect diff file '${relativePath}'.`, cause),
        ),
      );
    if (info.type !== "File") {
      return yield* fileError(root, `Diff path '${relativePath}' is not a file.`);
    }
    if (info.size > BigInt(FILE_CONTENTS_MAX_BYTES)) {
      return yield* fileError(
        root,
        `Diff file '${relativePath}' exceeds the 1 MB expansion limit.`,
      );
    }
    const bytes = yield* fileSystem
      .readFile(realTarget)
      .pipe(
        Effect.mapError((cause) =>
          fileError(root, `Could not read diff file '${relativePath}'.`, cause),
        ),
      );
    if (bytes.includes(0)) {
      return yield* fileError(root, `Cannot expand binary file '${relativePath}'.`);
    }
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  });

  const getDiffFileContents: MonoreVcsDriver["Service"]["getDiffFileContents"] = Effect.fn(
    "MonoreVcsDriver.getDiffFileContents",
  )(function* (root, input) {
    if (input.changeType === "rename-pure" || input.changeType === "rename-changed") {
      todo("a monore rename, which monore does not record");
    }
    const oldRef =
      input.baseRef ??
      (input.sourceKind === "working-tree"
        ? (yield* status("MonoreVcsDriver.getDiffFileContents.status", root)).head
        : null);
    if (oldRef === null || (input.sourceKind !== "working-tree" && input.headRef === null)) {
      return yield* fileError(root, "Selected comparison is no longer available.");
    }
    const [oldContents, newContents] = yield* Effect.all(
      [
        input.changeType === "new" ? Effect.succeed("") : showFile(root, oldRef, input.oldPath),
        input.changeType === "deleted"
          ? Effect.succeed("")
          : input.sourceKind === "working-tree"
            ? diskFile(root, input.newPath)
            : showFile(root, input.headRef!, input.newPath),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const commitOf = (
    changeset: MonoreCli.MonoreChangeset,
    decorations: ReadonlyMap<string, ReadonlyArray<string>>,
  ): ReviewLogCommit => {
    const author = splitAuthor(changeset.author);
    const message = changeset.message.replace(/\n+$/, "");
    return {
      sha: changeset.hash,
      // monore's log is first-parent, so a merge's other parents are not walked.
      parents: changeset.parents.slice(0, 1),
      subject: message.split("\n", 1)[0] ?? "",
      message,
      authorName: author.name,
      authorEmail: author.email,
      authoredAt: changeset.date,
      refs: decorations.get(changeset.hash) ?? [],
    };
  };

  const getLog: MonoreVcsDriver["Service"]["getLog"] = Effect.fn("MonoreVcsDriver.getLog")(
    function* (root, input) {
      const limit = input.limit ?? DEFAULT_LOG_LIMIT;
      const skip = input.skip ?? 0;
      const read = yield* status("MonoreVcsDriver.getLog.status", root);
      const tip = lastTip(root, read.base);
      const decorations = new Map<string, string[]>();
      for (const [hash, ref] of [
        [read.head, MONORE_HEAD_REF],
        [tip.tip, MONORE_TIP_REF],
      ] as const) {
        decorations.set(hash, [...(decorations.get(hash) ?? []), ref]);
      }
      const named = new Set(
        input.refs.map((ref) =>
          ref === "HEAD" || ref === MONORE_HEAD_REF || ref === "main" || ref === read.head
            ? "head"
            : ref === MONORE_TIP_REF || ref === "monore/main" || ref === tip.tip
              ? "tip"
              : ref,
        ),
      );
      // One page past `skip`.
      const want = limit;
      const page = (args: ReadonlyArray<string>, from: number, count: number) =>
        count <= 0
          ? Effect.succeed([] as ReadonlyArray<MonoreCli.MonoreChangeset>)
          : log("MonoreVcsDriver.getLog", root, [
              ...args,
              "--skip",
              String(from),
              "-n",
              String(count),
            ]).pipe(
              Effect.map((answer) => answer.changesets),
              Effect.mapError(refused),
            );
      const hashes = [...named].filter((ref) => ref !== "head" && ref !== "tip");
      if (named.size === 1 && hashes.length === 1) {
        // A hash alone: below the checkout's head, or anywhere on main's line.
        const [hash] = hashes;
        const own = yield* page([], 0, OWN_LOG_SEARCH);
        const at = own.findIndex((changeset) => changeset.hash === hash);
        const walked =
          at >= 0
            ? yield* page([], at + skip, want)
            : yield* page(["--from", hash!], skip, want).pipe(
                Effect.catchTags({
                  GitCommandError: (cause) =>
                    Effect.fail(
                      new GitCommandError({
                        operation: "MonoreVcsDriver.getLog",
                        command: "monore log",
                        cwd: root,
                        detail: `monore's history has no changeset ${hash}.`,
                        cause,
                      }),
                    ),
                }),
              );
        return {
          commits: walked.map((changeset) => commitOf(changeset, decorations)),
        } satisfies ReviewLogResult;
      }
      // Several starts (the Graph's stale head and tip after a move), each placed on the
      // incoming line (tip down to base) or the checkout's own log (stack, base, history):
      // the walk is the incoming line from its highest start, then the own log from its.
      const own = hashes.length > 0 ? yield* page([], 0, OWN_LOG_SEARCH) : [];
      const incomingSearch =
        hashes.length > 0
          ? yield* page(["--from", tip.tip], 0, Math.min(tip.behind, OWN_LOG_SEARCH))
          : [];
      let ownFrom = named.has("head") ? 0 : Number.POSITIVE_INFINITY;
      let incomingFrom = named.has("tip") && tip.behind > 0 ? 0 : Number.POSITIVE_INFINITY;
      // With nothing incoming the tip is the base, which tops the own log below the stack.
      if (named.has("tip") && tip.behind === 0) ownFrom = Math.min(ownFrom, read.stack.length);
      const unplaced: string[] = [];
      let belowSearch = false;
      let incomingLine: ReadonlyArray<MonoreCli.MonoreChangeset> | undefined;
      for (const hash of hashes) {
        const inOwn = own.findIndex((changeset) => changeset.hash === hash);
        const inIncoming = incomingSearch.findIndex((changeset) => changeset.hash === hash);
        if (inOwn >= 0) ownFrom = Math.min(ownFrom, inOwn);
        else if (inIncoming >= 0) incomingFrom = Math.min(incomingFrom, inIncoming);
        else {
          // Past both searches: on main's line (deep on the incoming line, or below the
          // base), or a changeset of a stack a land rebased onto a moved main, which is nowhere.
          const onMain = yield* log("MonoreVcsDriver.getLog.place", root, [
            "--from",
            hash,
            "-n",
            "1",
          ]).pipe(
            Effect.map((answer) => answer.changesets[0]?.hash === hash),
            Effect.catchTags({ MonoreRefusal: () => Effect.succeed(false) }),
            Effect.mapError(refused),
          );
          if (!onMain) {
            unplaced.push(hash);
            continue;
          }
          incomingLine ??=
            tip.behind > OWN_LOG_SEARCH ? yield* page(["--from", tip.tip], 0, tip.behind) : [];
          const deep = incomingLine.findIndex((changeset) => changeset.hash === hash);
          if (deep >= 0) incomingFrom = Math.min(incomingFrom, deep);
          // Below the base and past the own search, so below every start the search placed.
          else belowSearch = true;
        }
      }
      if (unplaced.length > 0) {
        return yield* new GitCommandError({
          operation: "MonoreVcsDriver.getLog",
          command: "monore log",
          cwd: root,
          detail: `${unplaced.join(", ")} ${unplaced.length === 1 ? "is" : "are"} on neither this checkout's line nor main's.`,
        });
      }
      if (
        belowSearch &&
        ownFrom === Number.POSITIVE_INFINITY &&
        incomingFrom === Number.POSITIVE_INFINITY
      ) {
        todo("a monore history walked from several changesets all deep below the base");
      }
      let walked: ReadonlyArray<MonoreCli.MonoreChangeset>;
      if (incomingFrom === Number.POSITIVE_INFINITY) {
        walked = yield* page([], ownFrom + skip, want);
      } else {
        // The incoming line runs into the base, so the own log goes on from it at the latest.
        ownFrom = Math.min(ownFrom, read.stack.length);
        const incomingLength = tip.behind - incomingFrom;
        const incoming = yield* page(
          ["--from", tip.tip],
          incomingFrom + skip,
          Math.min(want, incomingLength - skip),
        );
        const rest = yield* page(
          [],
          ownFrom + Math.max(0, skip - incomingLength),
          want - incoming.length,
        );
        walked = [...incoming, ...rest];
      }
      return {
        commits: walked.map((changeset) => commitOf(changeset, decorations)),
      } satisfies ReviewLogResult;
    },
  );

  const getRefs: MonoreVcsDriver["Service"]["getRefs"] = Effect.fn("MonoreVcsDriver.getRefs")(
    function* (root) {
      const read = yield* status("MonoreVcsDriver.getRefs", root);
      const tip = lastTip(root, read.base);
      return {
        head: { ref: MONORE_HEAD_REF, sha: read.head },
        refs: [
          { name: MONORE_HEAD_REF, sha: read.head, upstream: MONORE_TIP_REF },
          { name: MONORE_TIP_REF, sha: tip.tip, upstream: null },
        ],
      } satisfies ReviewRefsResult;
    },
  );

  const getLatest: MonoreVcsDriver["Service"]["getLatest"] = Effect.fn("MonoreVcsDriver.getLatest")(
    function* (root) {
      return yield* writeLocks.withLock(
        root,
        Effect.gen(function* () {
          const before = yield* status("MonoreVcsDriver.getLatest.status", root);
          yield* cli
            .write({ operation: "MonoreVcsDriver.getLatest", cwd: root, args: ["goto"] })
            .pipe(Effect.mapError(refused));
          const after = yield* status("MonoreVcsDriver.getLatest.status", root);
          return {
            status:
              after.base === before.base && after.head === before.head
                ? "skipped_up_to_date"
                : "pulled",
            refName: "main",
            upstreamRef: null,
          } satisfies VcsPullResult;
        }),
      );
    },
  );

  const runStackedAction: MonoreVcsDriver["Service"]["runStackedAction"] = Effect.fn(
    "MonoreVcsDriver.runStackedAction",
  )(function* (root, input, options) {
    const operation = "MonoreVcsDriver.runStackedAction";
    const emit = (
      event:
        | { readonly kind: "action_started"; readonly phases: GitActionProgressPhase[] }
        | {
            readonly kind: "phase_started";
            readonly phase: "commit" | "push";
            readonly label: string;
          }
        | { readonly kind: "action_finished"; readonly result: GitRunStackedActionResult }
        | {
            readonly kind: "action_failed";
            readonly phase: GitActionProgressPhase | null;
            readonly message: string;
          },
    ) =>
      options?.progressReporter?.publish({
        actionId: options.actionId ?? input.actionId,
        cwd: input.cwd,
        action: input.action,
        ...event,
      } as GitActionProgressEvent) ?? Effect.void;
    const refuse = (detail: string) => new GitManagerError({ operation, cwd: input.cwd, detail });

    const wantsCommit = input.action === "commit" || input.action === "commit_push";
    const wantsLand = input.action === "push" || input.action === "commit_push";
    let phase: "commit" | "push" | null = null;

    const steps = Effect.gen(function* () {
      if (
        input.action === "create_pr" ||
        input.action === "commit_push_pr" ||
        input.featureBranch === true
      ) {
        return yield* refuse("monore has no pull requests or branches.");
      }
      yield* emit({
        kind: "action_started",
        phases: [
          ...(wantsCommit ? ["commit" as const] : []),
          ...(wantsLand ? ["push" as const] : []),
        ],
      });
      const read = yield* status(`${operation}.status`, root);
      // During a conflict the merged paths are changes too, and a commit takes the sides
      // resolved; one resolved wholly to main's side has none, and its commit clears it.
      let commit: GitRunStackedActionResult["commit"] = { status: "skipped_not_requested" };
      let cleared = false;
      if (wantsCommit && read.changes.length === 0 && read.conflict === null) {
        commit = { status: "skipped_no_changes" };
      } else if (wantsCommit) {
        const message = input.commitMessage?.trim() ?? "";
        if (message === "") {
          return yield* refuse("A monore commit needs a message; Pult writes none for monore.");
        }
        phase = "commit";
        yield* emit({ kind: "phase_started", phase, label: "Committing…" });
        yield* cli
          .write({
            operation: `${operation}.commit`,
            cwd: root,
            args: ["commit", `--message=${message}`, "--", ...(input.filePaths ?? [])],
          })
          .pipe(Effect.mapError(refused));
        const committed = yield* status(`${operation}.status`, root);
        cleared = committed.head === read.head;
        commit = cleared
          ? { status: "skipped_no_changes" }
          : {
              status: "created",
              commitSha: committed.head,
              subject: message.split("\n", 1)[0]!.trim(),
            };
      }
      let push: GitRunStackedActionResult["push"] = { status: "skipped_not_requested" };
      if (wantsLand && cleared) {
        // The checkout is at main's tip, with nothing to land.
        push = { status: "skipped_up_to_date" };
      } else if (wantsLand) {
        phase = "push";
        yield* emit({ kind: "phase_started", phase, label: "Landing…" });
        yield* cli.land({ operation: `${operation}.land`, cwd: root }).pipe(
          Effect.catchTags({
            MonoreLandConflicted: () =>
              status(`${operation}.status`, root).pipe(
                Effect.flatMap((conflicted) => {
                  const count = conflicted.conflict?.paths.length ?? 0;
                  return Effect.fail(
                    refuse(
                      `The land conflicted in ${count} ${count === 1 ? "file" : "files"}: fix the markers or keep a side, then Commit & Land again.`,
                    ),
                  );
                }),
              ),
          }),
          Effect.mapError((error) => (error._tag === "MonoreRefusal" ? refused(error) : error)),
        );
        push = { status: "pushed", branch: "main" };
      }
      const result: GitRunStackedActionResult = {
        action: input.action,
        branch: { status: "skipped_not_requested" },
        commit,
        push,
        pr: { status: "skipped_not_requested" },
        toast: {
          title: cleared
            ? "Conflict cleared: main's side kept"
            : push.status === "pushed"
              ? commit.status === "created"
                ? "Committed and landed on main"
                : "Landed on main"
              : commit.status === "created"
                ? `Committed ${shortHash(commit.commitSha!)}`
                : "Nothing to commit",
          ...(commit.subject === undefined ? {} : { description: commit.subject }),
          cta:
            commit.status === "created" && push.status !== "pushed"
              ? { kind: "run_action", label: "Land", action: { kind: "push" } }
              : { kind: "none" },
        },
      };
      yield* emit({ kind: "action_finished", result });
      return result;
    });

    return yield* writeLocks.withLock(root, steps).pipe(
      Effect.tapError((error) =>
        emit({
          kind: "action_failed",
          phase,
          // The CLI's own message and hint, as a refusal carries them.
          message: error.detail,
        }),
      ),
    );
  });

  const resolveConflict: MonoreVcsDriver["Service"]["resolveConflict"] = Effect.fn(
    "MonoreVcsDriver.resolveConflict",
  )(function* (root, input) {
    yield* cli
      .write({
        operation: "MonoreVcsDriver.resolveConflict",
        cwd: root,
        args: ["resolve", `--${input.side}`, "--", ...input.paths],
      })
      .pipe(Effect.mapError(refused), (write) => writeLocks.withLock(root, write));
  });

  const checkouts: MonoreVcsDriver["Service"]["checkouts"] = (cwd) =>
    cli.checkouts({ operation: "MonoreVcsDriver.checkouts", cwd }).pipe(Effect.mapError(refused));

  const copies = yield* MonoreCopies.make(cli, writeLocks);

  return MonoreVcsDriver.of({
    localStatus,
    remoteStatus,
    getDiffPreview,
    getDiffFileContents,
    getLog,
    getRefs,
    getLatest,
    runStackedAction,
    resolveConflict,
    checkouts,
    createCopy: copies.create,
    canCopy: copies.canCopy,
    removeCopy: copies.remove,
    copyBase: copies.base,
    cleanSettledCopy: copies.cleanSettled,
  });
});

export const layer = Layer.effect(MonoreVcsDriver, make);
