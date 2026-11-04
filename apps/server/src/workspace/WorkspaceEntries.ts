// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectEntryChange,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWatchEntriesEvent,
  ProjectWatchEntriesInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as WorkspaceTreeWatcher from "./WorkspaceTreeWatcher.ts";

// Changes within this window after a batch's first change go out together.
const WATCH_BATCH_WINDOW = "100 millis";
// A batch past this many paths is sent truncated instead of growing.
const WATCH_BATCH_MAX_PATHS = 1_000;

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export class WorkspaceEntriesWatchError extends Schema.TaggedError<WorkspaceEntriesWatchError>()(
  "WorkspaceEntriesWatchError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to watch workspace entries in '${this.cwd}'.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

type WorkspaceEntriesWatchFailure =
  | WorkspacePaths.WorkspaceRootNotExistsError
  | WorkspacePaths.WorkspaceRootCreateFailedError
  | WorkspacePaths.WorkspaceRootStatFailedError
  | WorkspacePaths.WorkspaceRootNotDirectoryError
  | WorkspaceEntriesWatchError;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
    /**
     * Stream changes under a workspace root as batches coalesced over a short
     * window, leaving out `.git` and `node_modules`; subscribers to one root
     * share its OS watcher. Ends if the watcher closes, and fails as
     * subscribing would once the root is gone.
     */
    readonly watch: (
      input: ProjectWatchEntriesInput,
    ) => Stream.Stream<ProjectWatchEntriesEvent, WorkspaceEntriesWatchFailure>;
    /** Whether `watch` walks `.git` and `node_modules` too; see WorkspaceTreeWatcher. */
    readonly watchWalksIgnoredDirectories: boolean;
  }
>()("t3/workspace/WorkspaceEntries") {}

const hasDeletedAncestor = (changedPath: string, deleted: ReadonlySet<string>) => {
  const segments = changedPath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (deleted.has(segments.slice(0, depth).join("/"))) return true;
  }
  return false;
};

/** One root's shared watcher, as its subscribers see it. */
interface RootWatch {
  readonly changes: PubSub.PubSub<WorkspaceTreeWatcher.WorkspaceTreeChange>;
  // Succeeds when the watcher closes and fails when it fails.
  readonly done: Deferred.Deferred<void, WorkspaceTreeWatcher.WorkspaceTreeWatchError>;
  // Opened by the first subscriber once it has subscribed, so it misses nothing.
  readonly started: Latch.Latch;
}
/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** Children classified at once when listing a folder; each symlink costs a realpath and a stat. */
const SYMLINK_RESOLVE_BATCH_SIZE = 64;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const treeWatcher = yield* WorkspaceTreeWatcher.WorkspaceTreeWatcher;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ) {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
          function* (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          },
        );
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink, nestedGitRoots } = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            const isSameOrInside = (parent: string, child: string) => {
              const relativeChild = path.relative(parent, child);
              return (
                relativeChild !== ".." &&
                !relativeChild.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativeChild)
              );
            };
            // Reject canonical ancestors so "Expand all folders" cannot follow a cycle.
            let visitedFolders: Promise<ReadonlyArray<string>> | undefined;
            const loadVisitedFolders = () =>
              (visitedFolders ??= (async () => {
                const folders = [root];
                let current = normalizedCwd;
                for (const segment of target.relativePath.split("/").filter(Boolean)) {
                  current = path.join(current, segment);
                  folders.push(await NodeFSP.realpath(current));
                }
                return folders;
              })());
            const resolveSymlinkKind = async (
              name: string,
            ): Promise<ProjectEntry["kind"] | undefined> => {
              const resolved = await NodeFSP.realpath(path.join(directory, name)).catch(
                () => undefined,
              );
              if (
                resolved === undefined ||
                !isSameOrInside(root, resolved) ||
                path.relative(root, resolved).split(path.sep).includes(".git")
              ) {
                return undefined;
              }
              const stat = await NodeFSP.stat(resolved).catch(() => undefined);
              if (stat?.isFile()) return "file";
              if (!stat?.isDirectory()) return undefined;
              const folders = await loadVisitedFolders();
              return folders.some((folder) => isSameOrInside(resolved, folder))
                ? undefined
                : "directory";
            };
            // Bound filesystem work for directories such as pnpm node_modules.
            const kinds: Array<ProjectEntry["kind"] | undefined> = [];
            for (let offset = 0; offset < children.length; offset += SYMLINK_RESOLVE_BATCH_SIZE) {
              kinds.push(
                ...(await Promise.all(
                  children
                    .slice(offset, offset + SYMLINK_RESOLVE_BATCH_SIZE)
                    .map(async (child): Promise<ProjectEntry["kind"] | undefined> => {
                      if (child.name === ".git") return undefined;
                      if (child.isDirectory()) return "directory";
                      if (child.isFile()) return "file";
                      return child.isSymbolicLink() ? resolveSymlinkKind(child.name) : undefined;
                    }),
                )),
              );
            }
            const nestedGitRoots: Array<string> = [];
            const segments = target.relativePath.split("/").filter(Boolean);
            for (let index = 1; index <= segments.length; index += 1) {
              const candidate = segments.slice(0, index).join("/");
              const dotGit = await NodeFSP.lstat(path.join(normalizedCwd, candidate, ".git")).catch(
                () => null,
              );
              if (dotGit) nestedGitRoots.push(candidate);
            }
            return {
              nestedGitRoots,
              entries: children.flatMap((child, index): ProjectEntry[] => {
                const kind = kinds[index];
                if (kind === undefined) return [];
                return [
                  {
                    path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                    kind,
                  },
                ];
              }),
              // Git refuses to classify paths beyond a symbolic link.
              throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
            };
          },
          catch: toError,
        });
        let gitRoot = "";
        let gitPrefix = "";
        // stdin avoids argument limits; ignore classification is optional without git/repositories.
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: path.join(normalizedCwd, gitRoot),
              stdin: `${paths.map((entryPath) => entryPath.slice(gitPrefix.length)).join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Git refuses paths inside a submodule (128) but still answers for nested clones.
        for (const nestedGitRoot of nestedGitRoots) {
          if ((yield* checkIgnore([`${nestedGitRoot}/.git`]))?.exitCode !== 128) continue;
          gitRoot = nestedGitRoot;
          gitPrefix = `${gitRoot}/`;
        }
        const directoryGitPath = target.relativePath.slice(gitPrefix.length);
        // Check ignored folders once to avoid child index lookups; exit 0 guarantees no tracked descendants.
        // Symlinks and pathspec magic still need per-child checks.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          directoryGitPath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(directoryGitPath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(gitPrefix + ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  // One OS watcher per root, shared by its subscribers and closed with the
  // last of them. A watcher that stops leaves the map, so the next subscriber
  // starts a fresh one.
  const rootWatches: RcMap.RcMap<string, RootWatch> = yield* RcMap.make({
    lookup: Effect.fn("WorkspaceEntries.rootWatch")(function* (root: string) {
      const changes = yield* PubSub.unbounded<WorkspaceTreeWatcher.WorkspaceTreeChange>();
      const done = yield* Deferred.make<void, WorkspaceTreeWatcher.WorkspaceTreeWatchError>();
      const started = yield* Latch.make();
      yield* Latch.await(started).pipe(
        Effect.andThen(
          treeWatcher
            .watch(root)
            .pipe(Stream.runForEach((change) => PubSub.publish(changes, change))),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.andThen(RcMap.invalidate(rootWatches, root)),
        Effect.forkScoped,
      );
      return { changes, done, started };
    }),
  });

  /**
   * Kinds come from each path's state when its batch is cut: a missing path
   * is deleted, an existing one created if any of its events said it
   * appeared or moved there, else changed. FSEvents can flag an edit as a
   * creation too; reading one as created only makes a client re-read it.
   */
  const classifyChanges = Effect.fn("WorkspaceEntries.classifyChanges")(function* (
    root: string,
    batch: ReadonlyMap<string, boolean>,
  ) {
    const changes = yield* Effect.forEach(
      batch,
      ([changedPath, renamed]) =>
        Effect.promise(() =>
          NodeFSP.lstat(path.join(root, changedPath)).then(
            (): ProjectEntryChange["kind"] => (renamed ? "created" : "changed"),
            (error: NodeJS.ErrnoException): ProjectEntryChange["kind"] =>
              error.code !== "ENOENT" && error.code !== "ENOTDIR" ? "changed" : "deleted",
          ),
        ).pipe(Effect.map((kind) => ({ path: changedPath, kind }))),
      { concurrency: 16 },
    );
    const deleted = new Set(
      changes.flatMap((change) => (change.kind === "deleted" ? [change.path] : [])),
    );
    // A deleted directory stands for everything that was inside it.
    return changes.filter(
      (change) => change.kind !== "deleted" || !hasDeletedAncestor(change.path, deleted),
    );
  });

  const watch: WorkspaceEntries["Service"]["watch"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const root = yield* normalizeWorkspaceRoot(input.cwd);
        return Stream.callback<ProjectWatchEntriesEvent, WorkspaceEntriesWatchFailure>(
          (queue) =>
            Effect.gen(function* () {
              // Each changed path, and whether any of its events was a create or remove.
              let pending = new Map<string, boolean>();
              let truncated = false;
              const wake = yield* Queue.dropping<void>(1);

              yield* Effect.forever(
                Effect.gen(function* () {
                  yield* Queue.take(wake);
                  yield* Effect.sleep(WATCH_BATCH_WINDOW);
                  yield* Queue.clear(wake);
                  const batch = pending;
                  const batchTruncated = truncated;
                  pending = new Map();
                  truncated = false;
                  const changes = yield* classifyChanges(root, batch);
                  if (changes.length > 0 || batchTruncated) {
                    yield* Queue.offer(queue, { changes, truncated: batchTruncated });
                  }
                }),
              ).pipe(Effect.forkScoped);

              const rootWatch = yield* RcMap.get(rootWatches, root);
              const changes = yield* PubSub.subscribe(rootWatch.changes);
              yield* Latch.open(rootWatch.started);
              yield* PubSub.takeAll(changes).pipe(
                Effect.flatMap((taken) =>
                  Effect.sync(() => {
                    for (const change of taken) {
                      if (!pending.has(change.path) && pending.size >= WATCH_BATCH_MAX_PATHS) {
                        truncated = true;
                      } else {
                        pending.set(
                          change.path,
                          change.rename || pending.get(change.path) === true,
                        );
                      }
                    }
                    Queue.offerUnsafe(wake, undefined);
                  }),
                ),
                Effect.forever,
                Effect.forkScoped,
              );
              yield* Deferred.await(rootWatch.done).pipe(
                // Stream.callback neither ends nor fails the stream with this effect.
                Effect.matchEffect({
                  // The watcher closed, as it does when the root goes away.
                  // End the stream so the client can subscribe again, unless
                  // subscribing would fail.
                  onSuccess: () =>
                    normalizeWorkspaceRoot(input.cwd).pipe(
                      Effect.matchEffect({
                        onSuccess: () => Queue.end(queue),
                        onFailure: (error) => Queue.fail(queue, error),
                      }),
                    ),
                  onFailure: (cause) =>
                    Queue.fail(queue, new WorkspaceEntriesWatchError({ cwd: root, cause })),
                }),
              );
            }),
          // A slow subscriber holds the flush loop while changes keep
          // coalescing in `pending`, which is bounded.
          { bufferSize: 1 },
        );
      }),
    );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    const paths = result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .toSorted();
    const files = yield* Effect.promise(() =>
      Promise.all(
        paths.slice(0, IGNORED_FILES_LIMIT).map(async (relativePath) => {
          // lstat: a symlink usually points outside the workspace, where reads refuse to go.
          const stat = await NodeFSP.lstat(path.join(normalizedCwd, relativePath)).catch(
            () => null,
          );
          return stat?.isFile() ? { path: relativePath, byteLength: stat.size } : null;
        }),
      ),
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({
    browse,
    list,
    listIgnoredFiles,
    refresh,
    search,
    searchContents,
    watch,
    watchWalksIgnoredDirectories: treeWatcher.walksIgnoredDirectories,
  });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(WorkspaceTreeWatcher.layer),
);
