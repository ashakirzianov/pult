// Pult: an xaxis checkout's source control through the `xaxis` CLI, answering the RPCs the
// changes view and the Graph already call (`pult/decisions`, `xaxis-source-control-home`).
// A checkout is known by its `.xaxis-checkout` marker, so detection runs no process.
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
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
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
  type VcsRepositoryIdentity,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusXaxis,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as XaxisCli from "./XaxisCli.ts";

export const XAXIS_MARKER = ".xaxis-checkout";
/** A checkout's id, as the CLI writes it into the marker. */
const CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The branch and remote branch an xaxis checkout shows as: its own line, and main's tip. */
export const XAXIS_HEAD_REF = "refs/heads/main";
export const XAXIS_TIP_REF = "refs/remotes/xaxis/main";

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
function interruptedVerb(command: string | null): VcsStatusXaxis["interrupted"] {
  if (command === null) return null;
  if (command === "xaxis goto") return "get-latest";
  if (command === "xaxis land") return "commit-land";
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
      // `diff --git a/<path> b/<path>`, the two paths one, since xaxis has no renames.
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

/** `Name <id>`, the one author string an xaxis record keeps. */
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
 * The nearest folder from `cwd` upward holding `.xaxis-checkout` (a file whose
 * content is a checkout's id) or `.git`, and which: an xaxis checkout inside a
 * git repository is xaxis's, a repository inside a checkout git's (`pult/decisions`,
 * `vcs-detection-nearest`). Both in one folder fails; null with neither.
 */
export const nearestRepositoryMarker = Effect.fn("XaxisVcsDriver.nearestRepositoryMarker")(
  function* (cwd: string, options?: { readonly xaxisOnly?: boolean }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (detail: string, cause?: unknown) =>
      new VcsRepositoryDetectionError({
        operation: "XaxisVcsDriver.nearestRepositoryMarker",
        cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const isMarker = Effect.fn("XaxisVcsDriver.isMarker")(
      function* (folder: string) {
        const marker = path.join(folder, XAXIS_MARKER);
        const info = yield* fileSystem.stat(marker).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return false;
        const text = yield* fileSystem.readFileString(marker);
        return CHECKOUT_ID.test(text.trim());
      },
      Effect.mapError((cause) => fail("Could not read an .xaxis-checkout marker.", cause)),
    );
    let folder = path.resolve(cwd);
    while (true) {
      const [xaxis, git] = yield* Effect.all([
        isMarker(folder),
        options?.xaxisOnly
          ? Effect.succeed(false)
          : fileSystem
              .exists(path.join(folder, ".git"))
              .pipe(Effect.mapError((cause) => fail("Could not inspect a .git entry.", cause))),
      ]);
      if (xaxis && git) {
        return yield* fail(
          `${folder} holds both an .xaxis-checkout marker and .git; remove one of them.`,
        );
      }
      if (xaxis) {
        // Real, as git's toplevel is, so one checkout keys one queue of commands.
        const root = yield* fileSystem
          .realPath(folder)
          .pipe(Effect.mapError((cause) => fail("Could not resolve the checkout's root.", cause)));
        return { kind: "xaxis" as const, root };
      }
      if (git) return { kind: "git" as const, root: folder };
      const parent = path.dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  },
);

/**
 * The registry's xaxis driver: detection by the marker, no remotes (so no source
 * control provider attaches), and none of git's process-level operations. The source
 * control itself is `XaxisVcsDriver`.
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
      operation: `XaxisVcsDriver.${operation}`,
      kind: "xaxis",
      detail,
    });
  const noCheckpoints = () =>
    Effect.fail(unsupported("checkpoints", "An xaxis checkout keeps no turn checkpoints yet."));

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = (cwd) =>
    provide(nearestRepositoryMarker(cwd, { xaxisOnly: true })).pipe(
      Effect.flatMap((found) =>
        found === null
          ? Effect.succeed(null)
          : nowFreshness.pipe(
              Effect.map((freshness): VcsRepositoryIdentity => ({
                kind: "xaxis",
                rootPath: found.root,
                metadataPath: path.join(found.root, XAXIS_MARKER),
                freshness,
              })),
            ),
      ),
    );

  return VcsDriver.VcsDriver.of({
    execute: Effect.fn("XaxisVcsDriver.execute")(function* () {
      return yield* unsupported(
        "execute",
        "An xaxis checkout's CLI runs through XaxisVcsDriver alone.",
      );
    }),
    checkpoints: {
      captureCheckpoint: noCheckpoints,
      hasCheckpointRef: noCheckpoints,
      restoreCheckpoint: noCheckpoints,
      diffCheckpoints: noCheckpoints,
      listAuthoredPaths: noCheckpoints,
      deleteCheckpointRefs: noCheckpoints,
    },
    detectRepository,
    isInsideWorkTree: Effect.fn("XaxisVcsDriver.isInsideWorkTree")(function* (cwd) {
      return (yield* detectRepository(cwd)) !== null;
    }),
    listWorkspaceFiles: Effect.fn("XaxisVcsDriver.listWorkspaceFiles")(function* () {
      return yield* unsupported(
        "listWorkspaceFiles",
        "An xaxis checkout lists no workspace files yet.",
      );
    }),
    listRemotes: Effect.fn("XaxisVcsDriver.listRemotes")(function* () {
      return { remotes: [], freshness: yield* nowFreshness };
    }),
    filterIgnoredPaths: Effect.fn("XaxisVcsDriver.filterIgnoredPaths")(function* () {
      return yield* unsupported(
        "filterIgnoredPaths",
        "An xaxis checkout filters no ignored paths yet.",
      );
    }),
    initRepository: Effect.fn("XaxisVcsDriver.initRepository")(function* () {
      return yield* unsupported(
        "initRepository",
        "Pult does not make xaxis checkouts yet: run `xaxis checkout`.",
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
class XaxisTipUnread extends Schema.TaggedError<XaxisTipUnread>()("XaxisTipUnread", {
  reason: Schema.Literals(["signed-out", "unreachable"]),
}) {}

function tipUnread(error: XaxisCli.XaxisCliError): XaxisTipUnread | GitCommandError {
  if (error._tag !== "XaxisRefusal") return error;
  if (SIGNED_OUT_CODES.has(error.code)) return new XaxisTipUnread({ reason: "signed-out" });
  if (UNREACHABLE_CODES.has(error.code)) return new XaxisTipUnread({ reason: "unreachable" });
  return error.toCommandError();
}

type TipAnswer =
  | { readonly tip: TipRead }
  | { readonly unread: NonNullable<VcsStatusRemoteResult["xaxisTip"]> };

export class XaxisVcsDriver extends Context.Service<
  XaxisVcsDriver,
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
  }
>()("t3/vcs/XaxisVcsDriver") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const digest = yield* Digest.Digest;
  const settings = yield* ServerSettings.ServerSettingsService;
  const cli = XaxisCli.make(
    vcsProcess,
    settings.getSettings.pipe(
      Effect.map((current) => current.xaxisBinaryPath),
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
            operation: "XaxisVcsDriver.hashDiff",
            command: "crypto.digest SHA-256",
            cwd: root,
            detail: "Failed to hash review diff.",
            cause,
          }),
      ),
    );
  /** The last tip read per checkout, against the base it was read at. */
  const tips = new Map<string, TipRead>();

  const refused = (error: XaxisCli.XaxisCliError) =>
    error._tag === "XaxisRefusal" ? error.toCommandError() : error;
  const status = (
    operation: string,
    root: string,
  ): Effect.Effect<XaxisCli.XaxisStatus, GitCommandError> =>
    cli
      .json({ operation, cwd: root, args: ["status", "--json"] }, XaxisCli.XaxisStatus)
      .pipe(Effect.mapError(refused));
  const diff = (operation: string, root: string, args: ReadonlyArray<string>) =>
    cli.run({ operation, cwd: root, args: ["diff", ...args] }).pipe(Effect.mapError(refused));
  const log = (
    operation: string,
    root: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<XaxisCli.XaxisLog, XaxisCli.XaxisCliError> =>
    cli.json({ operation, cwd: root, args: ["log", "--json", ...args] }, XaxisCli.XaxisLog);
  /** The tip read last, while the checkout's base is still the one it was read at. */
  const lastTip = (root: string, base: string) => {
    const read = tips.get(root);
    return read !== undefined && read.base === base ? read : { tip: base, base, behind: 0 };
  };

  const localStatus: XaxisVcsDriver["Service"]["localStatus"] = Effect.fn(
    "XaxisVcsDriver.localStatus",
  )(function* (root) {
    const read = yield* status("XaxisVcsDriver.localStatus", root);
    const [edits, stack] = yield* Effect.all(
      [
        diff("XaxisVcsDriver.localStatus.diff", root, []),
        read.stack.length === 0
          ? Effect.succeed(null)
          : diff("XaxisVcsDriver.localStatus.stack", root, [read.base, read.head]),
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
      xaxis: {
        conflicts: (read.conflict?.paths ?? []).map(({ path, markers }) => ({ path, markers })),
        interrupted: interruptedVerb(read.interrupted),
      },
    } satisfies VcsStatusLocalResult;
  });

  const remoteStatus: XaxisVcsDriver["Service"]["remoteStatus"] = Effect.fn(
    "XaxisVcsDriver.remoteStatus",
  )(function* (root) {
    // The tip is xaxis's fetch: read on the broadcaster's cadence, whatever its upstream refresh says.
    const readTip = cli
      .json(
        { operation: "XaxisVcsDriver.remoteStatus", cwd: root, args: ["tip", "--json"] },
        XaxisCli.XaxisTip,
      )
      .pipe(
        Effect.map((tip): TipAnswer => ({ tip })),
        Effect.mapError(tipUnread),
        Effect.catchTags({
          XaxisTipUnread: (unread) => Effect.succeed<TipAnswer>({ unread: unread.reason }),
        }),
      );
    const [read, tip] = yield* Effect.all(
      [status("XaxisVcsDriver.remoteStatus.status", root), readTip],
      { concurrency: "unbounded" },
    );
    if ("tip" in tip) tips.set(root, tip.tip);
    return {
      hasUpstream: true,
      aheadCount: read.stack.length,
      behindCount: "tip" in tip ? tip.tip.behind : 0,
      pr: null,
      ...("unread" in tip ? { xaxisTip: tip.unread } : {}),
    } satisfies VcsStatusRemoteResult;
  });

  /** A changeset's record: in the checkout's own log, else on main's line. */
  const findChangeset = Effect.fn("XaxisVcsDriver.findChangeset")(function* (
    root: string,
    hash: string,
  ) {
    const own = yield* log("XaxisVcsDriver.findChangeset.own", root, [
      "-n",
      String(OWN_LOG_SEARCH),
    ]).pipe(Effect.mapError(refused));
    const found = own.changesets.find((changeset) => changeset.hash === hash);
    if (found !== undefined) return found;
    const onMain = yield* log("XaxisVcsDriver.findChangeset.main", root, [
      "--from",
      hash,
      "-n",
      "1",
    ]).pipe(
      Effect.catchTags({ XaxisRefusal: () => Effect.succeed({ changesets: [] }) }),
      Effect.mapError(refused),
    );
    const record = onMain.changesets[0];
    if (record?.hash === hash) return record;
    return yield* new GitCommandError({
      operation: "XaxisVcsDriver.findChangeset",
      command: "xaxis log",
      cwd: root,
      detail: "Selected commit is invalid or no longer available.",
    });
  });

  const getDiffPreview: XaxisVcsDriver["Service"]["getDiffPreview"] = Effect.fn(
    "XaxisVcsDriver.getDiffPreview",
  )(function* (root, input) {
    // Stock clients send `ignoreWhitespace` and `trackedOnly`: the CLI's diff keeps whitespace,
    // and its preview is always complete, as an older server's answer to `trackedOnly` is.
    if (input.baseRef !== undefined) {
      return yield* new GitCommandError({
        operation: "XaxisVcsDriver.getDiffPreview",
        command: "xaxis diff",
        cwd: root,
        detail: "An xaxis checkout's changes compare against its base alone.",
      });
    }
    const sourceKind = input.file?.sourceKind ?? input.sourceKind;
    const paths = input.file === undefined ? [] : ["--", input.file.path];
    const deferred = input.metadataOnly === true && input.file === undefined;
    const source = Effect.fn("XaxisVcsDriver.getDiffPreview.source")(function* (
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
          operation: "XaxisVcsDriver.getDiffPreview",
          command: "xaxis diff",
          cwd: root,
          detail: "Selected commit request is invalid.",
        });
      }
      const changeset = yield* findChangeset(root, input.commitSha);
      const parent = changeset.parents[0];
      if (parent === undefined) todo("an xaxis changeset with no parent");
      const patch = yield* diff("XaxisVcsDriver.getDiffPreview.commit", root, [
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

    const read = yield* status("XaxisVcsDriver.getDiffPreview.status", root);
    const [edits, stack] = yield* Effect.all(
      [
        sourceKind === "branch-range"
          ? Effect.succeed(null)
          : diff("XaxisVcsDriver.getDiffPreview.workingTree", root, paths),
        sourceKind === "working-tree" || read.stack.length === 0
          ? Effect.succeed(null)
          : diff("XaxisVcsDriver.getDiffPreview.stack", root, [read.base, read.head, ...paths]),
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
      operation: "XaxisVcsDriver.getDiffFileContents",
      command: "xaxis show",
      cwd: root,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  /** A file's bytes at a changeset as text, "" where there is no file. */
  const showFile = (root: string, hash: string, relativePath: string) =>
    cli
      .run({
        operation: "XaxisVcsDriver.getDiffFileContents.show",
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
          XaxisRefusal: (refusal) =>
            refusal.code === "no-such-path" ? Effect.succeed("") : Effect.fail(refused(refusal)),
        }),
      );

  const diskFile = Effect.fn("XaxisVcsDriver.diskFile")(function* (
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

  const getDiffFileContents: XaxisVcsDriver["Service"]["getDiffFileContents"] = Effect.fn(
    "XaxisVcsDriver.getDiffFileContents",
  )(function* (root, input) {
    if (input.changeType === "rename-pure" || input.changeType === "rename-changed") {
      todo("an xaxis rename, which xaxis does not record");
    }
    const oldRef =
      input.baseRef ??
      (input.sourceKind === "working-tree"
        ? (yield* status("XaxisVcsDriver.getDiffFileContents.status", root)).head
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
    changeset: XaxisCli.XaxisChangeset,
    decorations: ReadonlyMap<string, ReadonlyArray<string>>,
  ): ReviewLogCommit => {
    const author = splitAuthor(changeset.author);
    const message = changeset.message.replace(/\n+$/, "");
    return {
      sha: changeset.hash,
      // xaxis's log is first-parent, so a merge's other parents are not walked.
      parents: changeset.parents.slice(0, 1),
      subject: message.split("\n", 1)[0] ?? "",
      message,
      authorName: author.name,
      authorEmail: author.email,
      authoredAt: changeset.date,
      refs: decorations.get(changeset.hash) ?? [],
    };
  };

  const getLog: XaxisVcsDriver["Service"]["getLog"] = Effect.fn("XaxisVcsDriver.getLog")(
    function* (root, input) {
      const limit = input.limit ?? DEFAULT_LOG_LIMIT;
      const skip = input.skip ?? 0;
      const read = yield* status("XaxisVcsDriver.getLog.status", root);
      const tip = lastTip(root, read.base);
      const decorations = new Map<string, string[]>();
      for (const [hash, ref] of [
        [read.head, XAXIS_HEAD_REF],
        [tip.tip, XAXIS_TIP_REF],
      ] as const) {
        decorations.set(hash, [...(decorations.get(hash) ?? []), ref]);
      }
      const refs = input.refs !== undefined && input.refs.length > 0 ? input.refs : ["HEAD"];
      const named = new Set(
        refs.map((ref) =>
          ref === "HEAD" || ref === XAXIS_HEAD_REF || ref === "main" || ref === read.head
            ? "head"
            : ref === XAXIS_TIP_REF || ref === "xaxis/main" || ref === tip.tip
              ? "tip"
              : ref,
        ),
      );
      // One page past `skip`, and one more to know whether the walk goes on.
      const want = limit + 1;
      const page = (args: ReadonlyArray<string>, from: number, count: number) =>
        count <= 0
          ? Effect.succeed([] as ReadonlyArray<XaxisCli.XaxisChangeset>)
          : log("XaxisVcsDriver.getLog", root, [
              ...args,
              "--skip",
              String(from),
              "-n",
              String(count),
            ]).pipe(
              Effect.map((answer) => answer.changesets),
              Effect.mapError(refused),
            );
      let walked: ReadonlyArray<XaxisCli.XaxisChangeset>;
      if (named.size === 1 && named.has("head")) {
        walked = yield* page([], skip, want);
      } else if (named.size === 1 && named.has("tip")) {
        walked = yield* page(["--from", tip.tip], skip, want);
      } else if (named.size === 2 && named.has("head") && named.has("tip")) {
        // The incoming line, the tip down to the base, then the checkout's own log.
        const incoming = yield* page(["--from", tip.tip], skip, Math.min(want, tip.behind - skip));
        const own = yield* page([], Math.max(0, skip - tip.behind), want - incoming.length);
        walked = [...incoming, ...own];
      } else if (named.size === 1) {
        const [hash] = named;
        const own = yield* page([], 0, OWN_LOG_SEARCH);
        const at = own.findIndex((changeset) => changeset.hash === hash);
        walked =
          at >= 0
            ? yield* page([], at + skip, want)
            : yield* page(["--from", hash!], skip, want).pipe(
                Effect.catchTags({
                  GitCommandError: (cause) =>
                    Effect.fail(
                      new GitCommandError({
                        operation: "XaxisVcsDriver.getLog",
                        command: "xaxis log",
                        cwd: root,
                        detail: `xaxis's history has no changeset ${hash}.`,
                        cause,
                      }),
                    ),
                }),
              );
      } else {
        todo("an xaxis history walked from several changesets");
      }
      return {
        commits: walked.slice(0, limit).map((changeset) => commitOf(changeset, decorations)),
        hasMore: walked.length > limit,
      } satisfies ReviewLogResult;
    },
  );

  const getRefs: XaxisVcsDriver["Service"]["getRefs"] = Effect.fn("XaxisVcsDriver.getRefs")(
    function* (root) {
      const read = yield* status("XaxisVcsDriver.getRefs", root);
      const tip = lastTip(root, read.base);
      return {
        head: { ref: XAXIS_HEAD_REF, sha: read.head },
        refs: [
          { name: XAXIS_HEAD_REF, sha: read.head, upstream: XAXIS_TIP_REF },
          { name: XAXIS_TIP_REF, sha: tip.tip, upstream: null },
        ],
      } satisfies ReviewRefsResult;
    },
  );

  return XaxisVcsDriver.of({
    localStatus,
    remoteStatus,
    getDiffPreview,
    getDiffFileContents,
    getLog,
    getRefs,
  });
});

export const layer = Layer.effect(XaxisVcsDriver, make);
