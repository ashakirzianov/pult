import { getService, IDecorationsService, ILabelService, IWorkspaceContextService } from "@codingame/monaco-vscode-api";
import { IExplorerService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/browser/files.service";
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";

import { connection } from "../connection/index.ts";
import { threadStore } from "../threads/store.ts";
import { registerFilesCommands } from "./commands.ts";
import { projectsUnder, PULT_SCHEME, toUriPath } from "./paths.ts";
import { endedTurns } from "./projects.ts";
import { PultFileSystemProvider, workspaceDecorations } from "./provider.ts";
import {
  allWorkspaceFiles,
  environmentShell,
  knownRoots,
  pultFolders,
  releaseWorkspaceFiles,
  servicesReady,
  workspaceFiles,
} from "./workspace.ts";

/**
 * The `pult:` scheme as page code (`pult/decisions`, `pult-uri`): the
 * provider on the workbench's file service, registered before the workbench
 * initialises, so the explorer's restored `pult:` folders and tabs find it,
 * and the workspace's commands. Once the workbench is up, what keeps open
 * files current: each environment's folders' watches where its server has
 * them, synced as the folders change, and turn ends and reconnects in every
 * environment; and the explorer refreshed when the projects under a folder
 * above them change, since such a folder lists only the way to them. A
 * `pult:` path outside the workspace's folders (another checkout's row in
 * Source Control, a tab's hover) is labelled as its host path: unformatted,
 * the label service tildifies it by the page's home, `/`, as `~/Users/…`,
 * and it knows no environment's home.
 */
export function registerPultFiles(): void {
  const provider = new PultFileSystemProvider();
  registerCustomProvider(PULT_SCHEME, provider);
  registerFilesCommands();
  void followWorkspace(provider);
}

async function followWorkspace(provider: PultFileSystemProvider): Promise<void> {
  await servicesReady;
  (await getService(IDecorationsService)).registerDecorationsProvider(workspaceDecorations);
  (await getService(ILabelService)).registerFormatter({ scheme: PULT_SCHEME, formatting: { label: "${path}", separator: "/" } });
  (await getService(IWorkspaceContextService)).onDidChangeWorkspaceFolders(() => {
    for (const files of allWorkspaceFiles()) void files.syncWatches();
  });

  /** Per held environment: whether it was ready at the last change, and its threads' last completions. */
  const followed = new Map<string, { ready: boolean; completions: Map<string, number> }>();
  const followConnection = () => {
    const environments = connection.environments;
    for (const environmentId of followed.keys()) {
      if (!environments.some((environment) => environment.environmentId === environmentId)) followed.delete(environmentId);
    }
    releaseWorkspaceFiles();
    let reconnected = false;
    for (const environment of environments) {
      const state = followed.get(environment.environmentId) ?? { ready: false, completions: new Map() };
      followed.set(environment.environmentId, state);
      const ready = environment.phase === "ready";
      // Changes made while the environment was offline went unseen.
      if (ready && !state.ready) {
        const files = workspaceFiles(environment.environmentId);
        void files.syncWatches();
        for (const folder of pultFolders(environment.environmentId)) void files.refresh(folder.uri.path);
        reconnected = true;
      }
      state.ready = ready;
    }
    if (reconnected && provider.failedUnavailable) {
      provider.failedUnavailable = false;
      void refreshExplorer();
    }
  };
  // A thread's run that finished may have changed files under its root.
  const followTurns = () => {
    for (const [environmentId, state] of followed) {
      const ended = endedTurns(state.completions, environmentShell(environmentId));
      state.completions = ended.seen;
      for (const root of ended.roots) void workspaceFiles(environmentId).refresh(toUriPath(root));
    }
  };
  // A folder above the projects lists only the way to them, so a project added or gone under it changes what it lists.
  const listedProjects = new Map<string, string>();
  const followProjects = () => {
    let changed = false;
    for (const { environmentId } of connection.environments) {
      const roots = knownRoots(environmentId);
      const listed = pultFolders(environmentId)
        .flatMap((folder) => projectsUnder(folder.uri.path, roots))
        .toSorted()
        .join("\n");
      changed ||= listedProjects.has(environmentId) && listedProjects.get(environmentId) !== listed;
      listedProjects.set(environmentId, listed);
    }
    if (changed) void refreshExplorer();
  };
  connection.onDidChange(followConnection);
  threadStore.subscribe(followTurns);
  threadStore.subscribe(followProjects);
  followConnection();
  followTurns();
  followProjects();
}

/**
 * The explorer's tree read again, its folders' children forgotten even while
 * it is hidden, so it reads them when it shows; not the Refresh Explorer
 * command, which opens the Explorer tab first.
 */
async function refreshExplorer(): Promise<void> {
  await (await getService(IExplorerService)).refresh();
}
