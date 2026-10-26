// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectStatEntryInput,
  ProjectStatEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The version clients compare before writing. mtime alone misses a write in
 * the same tick on a coarse clock (one or two seconds on HFS+, FAT and some
 * network filesystems), so size joins it; the contract keeps it opaque so
 * it can get stronger.
 */
const fileVersion = (stat: { readonly mtimeMs: number; readonly size: number }) =>
  `${stat.mtimeMs}-${stat.size}`;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "remove",
      "rename",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFoundError extends Schema.TaggedError<WorkspacePathNotFoundError>()(
  "WorkspacePathNotFoundError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' does not exist.`;
  }
}

export class WorkspacePathExistsError extends Schema.TaggedError<WorkspacePathExistsError>()(
  "WorkspacePathExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' already exists.`;
  }
}

export class WorkspaceDirectoryNotEmptyError extends Schema.TaggedError<WorkspaceDirectoryNotEmptyError>()(
  "WorkspaceDirectoryNotEmptyError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace directory '${this.relativePath}' in '${this.workspaceRoot}' is not empty.`;
  }
}

export class WorkspaceFileVersionConflictError extends Schema.TaggedError<WorkspaceFileVersionConflictError>()(
  "WorkspaceFileVersionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    expectedVersion: Schema.String,
    // Absent when the file no longer exists.
    actualVersion: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' changed since the expected version.`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspacePathNotFoundError,
  WorkspacePathExistsError,
  WorkspaceDirectoryNotEmptyError,
  WorkspaceFileVersionConflictError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/**
 * Every mutation acts inside a known workspace only, never through a symlink
 * that leaves it, and never inside a Git folder, whose config and hooks run
 * code.
 */
type WorkspaceMutationError =
  | WorkspaceFileSystemError
  | WorkspacePaths.WorkspacePathOutsideRootError
  | KnownWorkspaces.UnknownWorkspaceError;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Describe what a path resolves to, accepting the same paths as `readFile`
     * and any relative path to the root itself, such as `""`, `.` or `./`. A
     * symlink that dangles or leaves the root is described as itself. A
     * missing path fails with `WorkspacePathNotFoundError`.
     */
    readonly statEntry: (
      input: ProjectStatEntryInput,
    ) => Effect.Effect<
      ProjectStatEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed. With `expectedVersion` it writes
     * only over that version of an existing file, else fails with
     * `WorkspaceFileVersionConflictError`.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<ProjectWriteFileResult, WorkspaceMutationError>;
    /**
     * Create a directory and any missing parents relative to the workspace
     * root. An existing directory is success; anything else there fails with
     * `WorkspacePathExistsError`.
     */
    readonly createDirectory: (
      input: ProjectCreateDirectoryInput,
    ) => Effect.Effect<ProjectCreateDirectoryResult, WorkspaceMutationError>;
    /**
     * Delete a file, symlink or directory relative to the workspace root. A
     * directory with anything in it needs `recursive`, else fails with
     * `WorkspaceDirectoryNotEmptyError`; a missing path fails with
     * `WorkspacePathNotFoundError`.
     */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<ProjectDeleteEntryResult, WorkspaceMutationError>;
    /**
     * Move a path within the workspace root, creating missing parents. An entry
     * already at the new path fails with `WorkspacePathExistsError` unless it is
     * the source under another case; a missing source fails with `WorkspacePathNotFoundError`.
     * The check is not atomic with the move, so an entry created in between is replaced.
     */
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<ProjectRenameEntryResult, WorkspaceMutationError>;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  const realpathWorkspaceRoot = Effect.fnUntraced(function* (
    input: { readonly cwd: string; readonly relativePath: string },
    resolvedPath: string,
  ) {
    const root = yield* WorkspacePaths.resolveWorkspaceRootPath(input.cwd, path);
    return yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath,
          operationPath: root,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
  });

  /**
   * Resolves the path a mutation acts on: its parent must lie inside the real
   * root once symlinks are followed, while the leaf is not followed, being itself
   * what gets deleted or moved. A missing parent is judged by its nearest existing
   * ancestor, which the result is built on; a dangling link among them fails, since creating through it would follow it.
   */
  const resolveMutationTarget = Effect.fn("WorkspaceFileSystem.resolveMutationTarget")(
    function* (input: { readonly cwd: string; readonly relativePath: string }) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: yield* WorkspacePaths.resolveWorkspaceRootPath(input.cwd, path),
        relativePath: input.relativePath,
      });
      const realWorkspaceRoot = yield* realpathWorkspaceRoot(input, target.absolutePath);
      const parentPath = path.dirname(target.absolutePath);
      const realParentPath = yield* Effect.tryPromise({
        try: async () => {
          const missing: Array<string> = [];
          let existing = parentPath;
          for (;;) {
            try {
              return path.join(await NodeFSP.realpath(existing), ...missing);
            } catch (cause) {
              const code = (cause as NodeJS.ErrnoException).code;
              if (
                (code !== "ENOENT" && code !== "ENOTDIR") ||
                path.dirname(existing) === existing
              ) {
                throw cause;
              }
              if (code === "ENOENT") {
                const exists = await NodeFSP.lstat(existing).then(
                  () => true,
                  () => false,
                );
                if (exists) throw cause;
              }
              missing.unshift(path.basename(existing));
              existing = path.dirname(existing);
            }
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: parentPath,
            operation: "realpath-target",
            cause,
          }),
      });
      const absolutePath = path.join(realParentPath, path.basename(target.absolutePath));
      if (!isInsideRealRoot(realWorkspaceRoot, realParentPath)) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: absolutePath,
        });
      }
      return { relativePath: target.relativePath, absolutePath, realWorkspaceRoot };
    },
  );

  /**
   * Nothing is created or written inside a Git folder, whose config and hooks
   * execute. Each path given is checked: the path as named catches a
   * `.git/config` symlink that resolves away the `.git`, the resolved one a
   * directory that links into it.
   */
  const assertOutsideGitFolder = Effect.fn("WorkspaceFileSystem.assertOutsideGitFolder")(function* (
    input: { readonly cwd: string; readonly relativePath: string },
    target: { readonly realWorkspaceRoot: string },
    checkedPaths: ReadonlyArray<string>,
  ) {
    for (const checkedPath of new Set(checkedPaths)) {
      const inGitFolder = yield* Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: checkedPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      });
      if (inGitFolder) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: target.realWorkspaceRoot,
          resolvedPath: checkedPath,
        });
      }
    }
  });

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
      : requestedPath;
    if (
      isNetworkPath(hostPath) &&
      !KnownWorkspaces.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      );
      return { relativePath: requestedPath, absolutePath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: yield* WorkspacePaths.resolveWorkspaceRootPath(input.cwd, path),
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* realpathWorkspaceRoot(input, target.absolutePath);
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      absolutePath: target.absolutePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated,
            // Writing truncated contents back would drop the rest.
            ...(truncated ? {} : { version: fileVersion(stat) }),
          };
        }),
      (handle) =>
        handle === null
          ? Effect.void
          : Effect.tryPromise({
              try: () => handle.close(),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "close",
                  cause,
                }),
            }),
    );
  });

  const describeEntry = (
    relativePath: string,
    linkStat: NodeFS.Stats,
    targetStat: NodeFS.Stats,
  ): ProjectStatEntryResult => ({
    relativePath,
    kind: targetStat.isFile() ? "file" : targetStat.isDirectory() ? "directory" : "other",
    symlink: linkStat.isSymbolicLink(),
    size: targetStat.size,
    mtimeMs: targetStat.mtimeMs,
    birthtimeMs: targetStat.birthtimeMs,
    version: fileVersion(targetStat),
  });

  // lstat answers whether the path is a link; stat of the real path describes
  // what it points at.
  const describeFollowed = Effect.fn("WorkspaceFileSystem.describeFollowed")(function* (
    input: ProjectStatEntryInput,
    target: {
      readonly relativePath: string;
      readonly absolutePath: string;
      readonly realTargetPath: string;
    },
  ) {
    const statAt = (operationPath: string, stat: (path: string) => Promise<NodeFS.Stats>) =>
      Effect.tryPromise({
        try: () => stat(operationPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.realTargetPath,
            operationPath,
            operation: "stat",
            cause,
          }),
      });
    const linkStat = yield* statAt(target.absolutePath, NodeFSP.lstat);
    const targetStat = yield* statAt(target.realTargetPath, NodeFSP.stat);
    return describeEntry(target.relativePath, linkStat, targetStat);
  });

  /**
   * Describes a symlink the server cannot or will not follow, dangling or
   * pointing outside the root, as itself, so a listing that shows it can stat
   * it. Anything else fails with `failure`, or as not found when nothing is
   * there.
   */
  const describeLinkItself = Effect.fn("WorkspaceFileSystem.describeLinkItself")(function* (
    input: ProjectStatEntryInput,
    failure: WorkspaceFilePathEscapeError | WorkspaceFileSystemOperationError,
  ) {
    const requestedPath = input.relativePath.trim();
    // A relative link's parent must still lie inside the root.
    const link = path.isAbsolute(requestedPath)
      ? { relativePath: requestedPath, absolutePath: requestedPath }
      : yield* resolveMutationTarget(input).pipe(
          // Under a dangling link nothing is there to describe.
          Effect.catchTags({
            WorkspaceFileSystemOperationError: (error) =>
              (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
                ? Effect.succeed(null)
                : Effect.fail(error),
          }),
        );
    const linkStat =
      link === null
        ? null
        : yield* Effect.promise(() => NodeFSP.lstat(link.absolutePath).catch(() => null));
    if (link !== null && linkStat?.isSymbolicLink()) {
      return describeEntry(link.relativePath, linkStat, linkStat);
    }
    if (linkStat === null && failure._tag === "WorkspaceFileSystemOperationError") {
      return yield* new WorkspacePathNotFoundError({
        workspaceRoot: failure.workspaceRoot,
        relativePath: failure.relativePath,
        resolvedPath: failure.resolvedPath,
        cause: failure.cause,
      });
    }
    return yield* failure;
  });

  const statEntry: WorkspaceFileSystem["Service"]["statEntry"] = Effect.fn(
    "WorkspaceFileSystem.statEntry",
  )(function* (input) {
    const requestedPath = input.relativePath.trim();
    const root = yield* WorkspacePaths.resolveWorkspaceRootPath(input.cwd, path);
    // The root itself, however spelled, which the path guard keeps from every
    // other method.
    if (!path.isAbsolute(requestedPath) && path.resolve(root, requestedPath) === root) {
      const realRoot = yield* realpathWorkspaceRoot(input, root).pipe(
        Effect.catchTags({
          WorkspaceFileSystemOperationError: (error) =>
            (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
              ? Effect.fail(
                  new WorkspacePathNotFoundError({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: root,
                    cause: error.cause,
                  }),
                )
              : Effect.fail(error),
        }),
      );
      return yield* describeFollowed(input, {
        relativePath: "",
        absolutePath: root,
        realTargetPath: realRoot,
      });
    }
    return yield* Effect.gen(function* () {
      const target = yield* resolveReadTarget(input);
      // Only `allowMissing` reads resolve to nothing, and statEntry never asks.
      if (target.realTargetPath === null) {
        return yield* new WorkspacePathNotFoundError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          cause: undefined,
        });
      }
      return yield* describeFollowed(input, { ...target, realTargetPath: target.realTargetPath });
    }).pipe(
      Effect.catchTags({
        WorkspaceFilePathEscapeError: (error) => describeLinkItself(input, error),
        WorkspaceFileSystemOperationError: (error) => {
          const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
          return error.operation === "realpath-target" && (code === "ENOENT" || code === "ELOOP")
            ? describeLinkItself(input, error)
            : Effect.fail(error);
        },
      }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const mutationTarget = yield* resolveMutationTarget(input);
    // A symlink at the path is written through when it resolves inside the
    // root. A dangling one is refused here; O_NOFOLLOW below refuses one
    // swapped in after this check.
    const realTargetPath = yield* Effect.tryPromise({
      try: () =>
        NodeFSP.realpath(mutationTarget.absolutePath).catch(
          async (cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
            const exists = await NodeFSP.lstat(mutationTarget.absolutePath).then(
              () => true,
              () => false,
            );
            if (exists) throw cause;
            return mutationTarget.absolutePath;
          },
        ),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: mutationTarget.absolutePath,
          operationPath: mutationTarget.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(mutationTarget.realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: mutationTarget.realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    yield* assertOutsideGitFolder(input, mutationTarget, [
      mutationTarget.absolutePath,
      realTargetPath,
    ]);
    const target = { relativePath: mutationTarget.relativePath, absolutePath: realTargetPath };

    const fileOperation = <A>(
      operation: WorkspaceFileSystemOperationError["operation"],
      run: () => Promise<A>,
    ) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation,
            cause,
          }),
      });
    const conflict = (expectedVersion: string, actualVersion?: string) =>
      new WorkspaceFileVersionConflictError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        expectedVersion,
        ...(actualVersion !== undefined ? { actualVersion } : {}),
      });
    const expectedVersion = input.expectedVersion;

    // A versioned write targets a file that already exists, so its parents do too.
    if (expectedVersion === undefined) {
      yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: path.dirname(target.absolutePath),
              operation: "make-directory",
              cause,
            }),
        ),
      );
    }

    // One handle carries the version check, the write and the new version, so
    // a file renamed over the path cannot come between them. A plain write
    // creates or truncates on open; a versioned one opens without either and
    // truncates only after its version matches.
    const { O_CREAT, O_NOFOLLOW = 0, O_RDWR, O_TRUNC, O_WRONLY } = NodeFS.constants;
    const openFile = (flags: number) =>
      fileOperation("open", () => NodeFSP.open(target.absolutePath, flags)).pipe(
        Effect.catchIf(
          (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "EISDIR",
          () =>
            Effect.fail(
              new WorkspacePathNotFileError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: target.absolutePath,
              }),
            ),
        ),
      );
    const open =
      expectedVersion === undefined
        ? openFile(O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW)
        : openFile(O_RDWR | O_NOFOLLOW).pipe(
            Effect.catchTags({
              WorkspaceFileSystemOperationError: (error) =>
                (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
                  ? Effect.fail(conflict(expectedVersion))
                  : Effect.fail(error),
            }),
          );
    const version = yield* Effect.acquireUseRelease(
      open,
      (handle) =>
        Effect.gen(function* () {
          if (expectedVersion !== undefined) {
            const current = fileVersion(yield* fileOperation("stat", () => handle.stat()));
            if (current !== expectedVersion) {
              return yield* conflict(expectedVersion, current);
            }
            yield* fileOperation("write-file", () => handle.truncate(0));
          }
          yield* fileOperation("write-file", () => handle.writeFile(input.contents));
          const written = yield* fileOperation("stat", () => handle.stat());
          return fileVersion(written);
        }),
      (handle) => fileOperation("close", () => handle.close()),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, version };
  });

  const createDirectory: WorkspaceFileSystem["Service"]["createDirectory"] = Effect.fn(
    "WorkspaceFileSystem.createDirectory",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveMutationTarget(input);
    yield* assertOutsideGitFolder(input, target, [target.absolutePath]);
    yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "AlreadyExists"
          ? new WorkspacePathExistsError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              cause,
            })
          : new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              operationPath: target.absolutePath,
              operation: "make-directory",
              cause,
            }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveMutationTarget(input);
    yield* Effect.tryPromise({
      try: async () => {
        if (input.recursive === true) {
          return NodeFSP.rm(target.absolutePath, { recursive: true });
        }
        // rm refuses any directory without `recursive`, even an empty one.
        const stat = await NodeFSP.lstat(target.absolutePath);
        return stat.isDirectory()
          ? NodeFSP.rmdir(target.absolutePath)
          : NodeFSP.rm(target.absolutePath);
      },
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException).code;
        const context = {
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          cause,
        };
        return code === "ENOENT"
          ? new WorkspacePathNotFoundError(context)
          : code === "ENOTEMPTY" || code === "EEXIST"
            ? new WorkspaceDirectoryNotEmptyError(context)
            : new WorkspaceFileSystemOperationError({
                ...context,
                operationPath: target.absolutePath,
                operation: "remove",
              });
      },
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const source = yield* resolveMutationTarget(input);
    const destinationInput = { cwd: input.cwd, relativePath: input.newRelativePath };
    const destination = yield* resolveMutationTarget(destinationInput);
    yield* assertOutsideGitFolder(destinationInput, destination, [destination.absolutePath]);
    const operationError = (
      operation: WorkspaceFileSystemOperationError["operation"],
      operationPath: string,
      cause: unknown,
    ) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: source.absolutePath,
        operationPath,
        operation,
        cause,
      });

    const sourceStat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(source.absolutePath),
      catch: (cause) =>
        (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          ? new WorkspacePathNotFoundError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: source.absolutePath,
              cause,
            })
          : operationError("stat", source.absolutePath, cause),
    });
    const destinationStat = yield* Effect.tryPromise({
      try: () =>
        NodeFSP.lstat(destination.absolutePath).catch((cause: NodeJS.ErrnoException) =>
          cause.code === "ENOENT" ? null : Promise.reject(cause),
        ),
      catch: (cause) => operationError("stat", destination.absolutePath, cause),
    });
    // On a case-insensitive filesystem a new case of the same name finds the
    // source itself, which the rename may replace.
    const isSourceUnderAnotherCase =
      destinationStat !== null &&
      destinationStat.dev === sourceStat.dev &&
      destinationStat.ino === sourceStat.ino &&
      destination.absolutePath.toLowerCase() === source.absolutePath.toLowerCase();
    if (destinationStat !== null && !isSourceUnderAnotherCase) {
      return yield* new WorkspacePathExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.newRelativePath,
        resolvedPath: destination.absolutePath,
      });
    }

    const destinationParent = path.dirname(destination.absolutePath);
    yield* fileSystem
      .makeDirectory(destinationParent, { recursive: true })
      .pipe(Effect.mapError((cause) => operationError("make-directory", destinationParent, cause)));
    yield* fileSystem
      .rename(source.absolutePath, destination.absolutePath)
      .pipe(Effect.mapError((cause) => operationError("rename", destination.absolutePath, cause)));
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: destination.relativePath };
  });

  return WorkspaceFileSystem.of({
    createDirectory,
    deleteEntry,
    getMetadata,
    readFile,
    renameEntry,
    statEntry,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
