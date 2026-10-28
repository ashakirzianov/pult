import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Disposable, type IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  createFileSystemProviderError,
  FilePermission,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileFolderCopyCapability,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import { registerColor } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colorUtils";
import type { IDecorationsProvider } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/decorations/common/decorations";

import { connection } from "../connection/index.ts";
import { type FilesErrorCode, type Stat, toFilesError, type WorkspaceFiles } from "./files.ts";
import { namesEnvironment, PULT_SCHEME } from "./paths.ts";
import { whenReady } from "./server.ts";
import { decorationChanges, fileChanges, servicesReady, whenListed, workspaceFiles } from "./workspace.ts";

const ERROR_CODES: Record<FilesErrorCode, FileSystemProviderErrorCode> = {
  FileNotFound: FileSystemProviderErrorCode.FileNotFound,
  FileExists: FileSystemProviderErrorCode.FileExists,
  FileNotADirectory: FileSystemProviderErrorCode.FileNotADirectory,
  FileIsADirectory: FileSystemProviderErrorCode.FileIsADirectory,
  NoPermissions: FileSystemProviderErrorCode.NoPermissions,
  Unavailable: FileSystemProviderErrorCode.Unavailable,
  Unknown: FileSystemProviderErrorCode.Unknown,
};

/**
 * The `pult:` file system provider, on the workbench's own file service: its
 * face of `WorkspaceFiles`. It serves the connected environment's URIs and
 * refuses another environment's, since the page holds one connection. A call
 * made while the page connects waits for it, as the workbench restores
 * `pult:` folders and tabs before the saved environment is back.
 */
export class PultFileSystemProvider
  implements IFileSystemProviderWithFileReadWriteCapability, IFileSystemProviderWithFileFolderCopyCapability
{
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.FileFolderCopy |
    FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  readonly onDidChangeFile = fileChanges.event;
  /** Set when a call failed for want of a connection, so the Explorer can be refreshed once it is back. */
  failedUnavailable = false;

  /** The workspace folders' own `watchEntries` subscriptions report changes; see `WorkspaceFiles.syncWatches`. */
  watch(): IDisposable {
    return Disposable.None;
  }

  stat(resource: URI): Promise<IStat> {
    return this.call(resource, (files, path) => files.stat(path)).then(toStat);
  }

  readdir(resource: URI): Promise<Array<[string, FileType]>> {
    return this.call(resource, (files, path) => files.readDirectory(path)).then((entries) =>
      entries.map(([name, kind]) => [name, kind === "directory" ? FileType.Directory : FileType.File]),
    );
  }

  readFile(resource: URI): Promise<Uint8Array> {
    return this.call(resource, (files, path) => files.readFile(path));
  }

  writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
    return this.call(resource, (files, path) =>
      files.writeFile(path, content, { create: options.create, overwrite: options.overwrite }),
    );
  }

  mkdir(resource: URI): Promise<void> {
    return this.call(resource, (files, path) => files.createDirectory(path));
  }

  delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
    return this.call(resource, (files, path) => files.delete(path, { recursive: options.recursive }));
  }

  /** The file service deletes an existing target itself before an overwriting move. */
  rename(from: URI, to: URI): Promise<void> {
    return this.call(to, () => this.call(from, (files, path) => files.rename(path, to.path)));
  }

  /** The file service copies through this rather than a read and a write; see `WorkspaceFiles.copy`. */
  copy(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void> {
    return this.call(to, () => this.call(from, (files, path) => files.copy(path, to.path, { overwrite: options.overwrite })));
  }

  private async call<A>(resource: URI, operation: (files: WorkspaceFiles, path: string) => Promise<A>): Promise<A> {
    try {
      await whenReady();
      const environment = connection.environment;
      if (environment !== null && !namesEnvironment(resource.authority, environment.environmentId)) {
        throw createFileSystemProviderError(
          `${resource.toString()} is on another environment than Pult's ${environment.label}. The page holds one environment: connect to that one to open it.`,
          FileSystemProviderErrorCode.Unavailable,
        );
      }
      await Promise.all([servicesReady, whenListed()]);
      return await operation(workspaceFiles(), resource.path);
    } catch (error) {
      if (error instanceof FileSystemProviderError) throw error;
      const failure = toFilesError(error, resource.path);
      if (failure.code === "Unavailable") this.failedUnavailable = true;
      throw createFileSystemProviderError(failure.message, ERROR_CODES[failure.code]);
    }
  }
}

function toStat(stat: Stat): IStat {
  const type = stat.kind === "directory" ? FileType.Directory : stat.kind === "file" ? FileType.File : FileType.Unknown;
  return {
    type: stat.symlink ? type | FileType.SymbolicLink : type,
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    ...(stat.readonly ? { permissions: FilePermission.Readonly } : {}),
  };
}

/** Ignored entries' colour, as Git greys them. */
const IGNORED_FOREGROUND = registerColor(
  "pult.ignoredResourceForeground",
  { dark: "#8C8C8C", light: "#8E8E90", hcDark: "#A7A8A9", hcLight: "#8E8E90" },
  "Color for files and folders the project ignores, in Pult's workspace folders.",
);

/** Ignored entries greyed, and a workspace folder gone from the host marked. */
export const workspaceDecorations: IDecorationsProvider = {
  label: "Pult",
  onDidChange: decorationChanges.event,
  provideDecorations: (resource) => {
    if (resource.scheme !== PULT_SCHEME) return undefined;
    const environmentId = connection.environment?.environmentId;
    if (environmentId === undefined || !namesEnvironment(resource.authority, environmentId)) return undefined;
    const files = workspaceFiles();
    if (files.isGone(resource.path)) {
      return { weight: 10, letter: "!", tooltip: "Gone from the host", color: "list.errorForeground" };
    }
    if (files.isIgnored(resource.path)) return { weight: 10, tooltip: "Ignored", color: IGNORED_FOREGROUND };
    return undefined;
  },
};
