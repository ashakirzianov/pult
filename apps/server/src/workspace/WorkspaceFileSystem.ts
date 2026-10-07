// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write/stat operations and their
 * associated safety checks and cache invalidation hooks. Reads and stats also
 * accept absolute host paths so clients can show files an agent left outside
 * the workspace; writes never leave the root.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectStatEntryInput,
  ProjectStatEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
// Matches the largest image a turn can attach, which travels as a data URL
// over the same socket.
const PROJECT_READ_FILE_BASE64_MAX_BYTES = 10 * 1024 * 1024;

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

export class WorkspaceFileVersionConflictError extends Schema.TaggedError<WorkspaceFileVersionConflictError>()(
  "WorkspaceFileVersionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    expectedMtimeMs: Schema.Number,
    // Absent when the file no longer exists.
    actualMtimeMs: Schema.optional(Schema.Number),
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
  WorkspaceFileVersionConflictError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path. With `encoding: "base64"` it returns any file's bytes.
     */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Describe what a path resolves to, accepting the same paths as `readFile`.
     * A missing path fails with `WorkspacePathNotFoundError`.
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
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root. With `expectedMtimeMs` it writes only over that version
     * of an existing file, else fails with `WorkspaceFileVersionConflictError`.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Create a directory and any missing parents relative to the workspace
     * root. An existing directory is success; anything else there fails with
     * `WorkspacePathExistsError`.
     */
    readonly createDirectory: (
      input: ProjectCreateDirectoryInput,
    ) => Effect.Effect<
      ProjectCreateDirectoryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Delete a file, symlink or directory tree relative to the workspace
     * root. A missing path fails with `WorkspacePathNotFoundError`.
     */
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  /**
   * Resolves the file a read targets. Workspace-relative paths must stay inside the
   * root, symlinks included. An absolute path reads a host file in place, such as a
   * report an agent wrote to a temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, absolutePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
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
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      absolutePath: target.absolutePath,
      realTargetPath,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;
    const encoding = input.encoding ?? "utf8";
    const maxBytes =
      encoding === "base64" ? PROJECT_READ_FILE_BASE64_MAX_BYTES : PROJECT_READ_FILE_MAX_BYTES;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
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
      }),
      (handle) =>
        Effect.gen(function* () {
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

          const bytesToRead = Math.min(stat.size, maxBytes);
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
          if (encoding === "utf8" && fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents:
              encoding === "base64"
                ? fileBytes.toString("base64")
                : new TextDecoder("utf-8").decode(fileBytes),
            encoding,
            byteLength: stat.size,
            truncated: stat.size > maxBytes,
            mtimeMs: stat.mtimeMs,
          };
        }),
      (handle) =>
        Effect.tryPromise({
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

  const statEntry: WorkspaceFileSystem["Service"]["statEntry"] = Effect.fn(
    "WorkspaceFileSystem.statEntry",
  )(function* (input) {
    const target = yield* resolveReadTarget(input).pipe(
      Effect.catchIf(
        (error): error is WorkspaceFileSystemOperationError =>
          error._tag === "WorkspaceFileSystemOperationError" &&
          error.operation === "realpath-target" &&
          (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
        (error) =>
          Effect.fail(
            new WorkspacePathNotFoundError({
              workspaceRoot: error.workspaceRoot,
              relativePath: error.relativePath,
              resolvedPath: error.resolvedPath,
              cause: error.cause,
            }),
          ),
      ),
    );
    // lstat answers whether the path is a link; stat of the real path
    // describes what it points at.
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
    return {
      relativePath: target.relativePath,
      kind: targetStat.isFile() ? "file" : targetStat.isDirectory() ? "directory" : "other",
      symlink: linkStat.isSymbolicLink(),
      size: targetStat.size,
      mtimeMs: targetStat.mtimeMs,
      birthtimeMs: targetStat.birthtimeMs,
    } as const;
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

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
    const conflict = (expectedMtimeMs: number, actualMtimeMs?: number) =>
      new WorkspaceFileVersionConflictError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.absolutePath,
        expectedMtimeMs,
        ...(actualMtimeMs !== undefined ? { actualMtimeMs } : {}),
      });
    const expectedMtimeMs = input.expectedMtimeMs;

    // A versioned write targets a file that already exists, so its parents do too.
    if (expectedMtimeMs === undefined) {
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
    const open =
      expectedMtimeMs === undefined
        ? fileOperation("open", () => NodeFSP.open(target.absolutePath, "w"))
        : fileOperation("open", () => NodeFSP.open(target.absolutePath, "r+")).pipe(
            Effect.catchIf(
              (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
              () => Effect.fail(conflict(expectedMtimeMs)),
            ),
          );
    const mtimeMs = yield* Effect.acquireUseRelease(
      open,
      (handle) =>
        Effect.gen(function* () {
          if (expectedMtimeMs !== undefined) {
            const current = yield* fileOperation("stat", () => handle.stat());
            if (current.mtimeMs !== expectedMtimeMs) {
              return yield* conflict(expectedMtimeMs, current.mtimeMs);
            }
            yield* fileOperation("write-file", () => handle.truncate(0));
          }
          yield* fileOperation("write-file", () => handle.writeFile(input.contents));
          const written = yield* fileOperation("stat", () => handle.stat());
          return written.mtimeMs;
        }),
      (handle) => fileOperation("close", () => handle.close()),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, mtimeMs };
  });

  const createDirectory: WorkspaceFileSystem["Service"]["createDirectory"] = Effect.fn(
    "WorkspaceFileSystem.createDirectory",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
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
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    yield* fileSystem.remove(target.absolutePath, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? new WorkspacePathNotFoundError({
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
              operation: "remove",
              cause,
            }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({
    createDirectory,
    deleteEntry,
    readFile,
    statEntry,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
