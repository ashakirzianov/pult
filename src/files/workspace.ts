import {
  getService,
  IModelService,
  INotificationService,
  IWorkspaceContextService,
} from "@codingame/monaco-vscode-api";
import { Emitter } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { FileChangeType, type IFileChange } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import type { IWorkspaceFolder } from "@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { connection } from "../connection/index.ts";
import { threadStore } from "../threads/store.ts";
import { type Change, WorkspaceFiles, type WorkspaceFilesHost } from "./files.ts";
import { baseName, namesEnvironment, PULT_SCHEME, toUriPath } from "./paths.ts";
import { projectRoots } from "./projects.ts";
import { environmentServer } from "./server.ts";

/**
 * The page's `pult:` workspace (`pult/decisions`, `pult-uri`): each held
 * environment's files as its own `WorkspaceFiles` serves them, a URI's
 * authority naming the environment, the workbench's view of them (its
 * folders, its open models) as each one's host, and the events the provider
 * and the decorations fire.
 */

/** The services the host reads synchronously, once the workbench's are up; every provider call waits for them. */
let services:
  | {
      readonly workspace: IWorkspaceContextService;
      readonly models: IModelService;
      readonly notifications: INotificationService;
    }
  | undefined;

export const servicesReady = Promise.all([
  getService(IWorkspaceContextService),
  getService(IModelService),
  getService(INotificationService),
]).then(([workspace, models, notifications]) => {
  services = { workspace, models, notifications };
});

export const fileChanges = new Emitter<ReadonlyArray<IFileChange>>();
export const decorationChanges = new Emitter<ReadonlyArray<URI>>();

const CHANGE_TYPES: Record<Change["kind"], FileChangeType> = {
  created: FileChangeType.ADDED,
  changed: FileChangeType.UPDATED,
  deleted: FileChangeType.DELETED,
};

/** A `pult:` URI path on the environment. */
export function pultResource(environmentId: string, path: string): URI {
  return URI.from({ scheme: PULT_SCHEME, authority: environmentId, path });
}

/** The workspace's `pult:` folders on the environment, or on every held environment without one. */
export function pultFolders(environmentId?: string): ReadonlyArray<IWorkspaceFolder> {
  if (services === undefined) return [];
  const held = environmentId === undefined ? connection.environments.map((environment) => environment.environmentId) : [environmentId];
  return services.workspace
    .getWorkspace()
    .folders.filter((folder) => folder.uri.scheme === PULT_SCHEME && held.some((id) => namesEnvironment(folder.uri.authority, id)));
}

/** How long a call waits for the store to list the environment's projects. */
const LISTED_TIMEOUT_MS = 15_000;

/**
 * Resolves once the store lists a project root of the environment, the
 * roots a file outside the folders is read against: the workbench restores
 * `pult:` tabs as soon as the connection is ready, before the thread model
 * has loaded the environment's projects (the store may carry the
 * environment alone at first). After a wait it resolves anyway, as for an
 * environment with no projects, and the read fails as `WorkspaceFiles` fails it.
 */
export function whenListed(environmentId: string): Promise<void> {
  const listed = () => projectRoots(environmentShell(environmentId)).length > 0;
  if (listed()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = threadStore.subscribe(() => {
      if (listed()) done();
    });
    const timer = setTimeout(done, LISTED_TIMEOUT_MS);
  });
}

/**
 * The environment's projects and threads as the store has them, in the shape
 * of the server's shell that `projects.ts` takes: a project only a thread
 * names stands in for one the model does not list, and the store carries
 * no worktrees yet.
 */
export function environmentShell(environmentId: string) {
  const state = threadStore.get();
  const projects = state.projects.filter((project) => namesEnvironment(project.environmentId, environmentId));
  const threads = state.threads.filter((thread) => namesEnvironment(thread.environmentId, environmentId));
  const known = new Map(projects.map((project) => [project.id, project]));
  for (const thread of threads) {
    const project = known.has(thread.projectId) ? undefined : threadStore.project(thread.environmentId, thread.projectId);
    if (project !== undefined) known.set(project.id, project);
  }
  return {
    projects: [...known.values()].flatMap((project) =>
      project.root === null ? [] : [{ id: ProjectId.make(project.id), title: project.name, workspaceRoot: project.root }],
    ),
    threads: threads.map((thread) => ({
      id: ThreadId.make(thread.id),
      projectId: ProjectId.make(thread.projectId),
      worktreePath: null,
      branch: thread.branch,
      deletedAt: null,
      updatedAt: DateTime.makeUnsafe(thread.updatedAt),
      latestRunCompletedAt: thread.latestRun?.finishedAt ? DateTime.makeUnsafe(thread.latestRun.finishedAt) : null,
    })),
  };
}

/** The workbench as the environment's files see it: its folders and open models on that environment. */
function hostOf(environmentId: string): WorkspaceFilesHost {
  const resource = (path: string) => pultResource(environmentId, path);
  return {
    roots: () => pultFolders(environmentId).map((folder) => folder.uri.path),
    knownRoots: () => projectRoots(environmentShell(environmentId)).map((root) => toUriPath(root.path)),
    openPaths: () =>
      services === undefined
        ? []
        : services.models
            .getModels()
            .filter(({ uri }) => uri.scheme === PULT_SCHEME && namesEnvironment(uri.authority, environmentId))
            .map(({ uri }) => uri.path),
    changed: (list) => fileChanges.fire(list.map((change) => ({ type: CHANGE_TYPES[change.kind], resource: resource(change.path) }))),
    decorated: (paths) => decorationChanges.fire(paths.map(resource)),
    openedReadOnly: (path, reason, byteLength) =>
      services?.notifications.warn(
        reason === "truncated"
          ? `Pult: ${baseName(path)} is ${(byteLength / 2 ** 20).toFixed(1)} MiB, more than the server reads, so it opened truncated and read-only.`
          : `Pult: ${baseName(path)} is not plain UTF-8, which the server reads only as text, so it opened read-only.`,
      ),
  };
}

/** Each held environment's files, by its id as the connection has it. */
const filesByEnvironment = new Map<string, WorkspaceFiles>();

/**
 * The files of the environment a `pult:` authority names, in any case. What
 * they know (versions served, read-only marks, watches, folders gone) is
 * that environment's, kept while the page holds it (`releaseWorkspaceFiles`).
 */
export function workspaceFiles(environmentId: string): WorkspaceFiles {
  const id = connection.environment(environmentId)?.environmentId ?? environmentId;
  let files = filesByEnvironment.get(id);
  if (files === undefined) {
    files = new WorkspaceFiles(environmentServer(id), hostOf(id));
    filesByEnvironment.set(id, files);
  }
  return files;
}

/** Every held environment's files, for what reaches them all: a change of the folders. */
export function allWorkspaceFiles(): ReadonlyArray<WorkspaceFiles> {
  return connection.environments.map((environment) => workspaceFiles(environment.environmentId));
}

/** Lets go of the files of environments the page no longer holds; one held again starts afresh. */
export function releaseWorkspaceFiles(): void {
  for (const [id, files] of filesByEnvironment) {
    if (connection.environment(id) !== undefined) continue;
    files.dispose();
    filesByEnvironment.delete(id);
  }
}
