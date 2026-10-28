import { getService, ICommandService, IDecorationsService, IWorkspaceContextService } from "@codingame/monaco-vscode-api";
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";

import { connection } from "../connection/index.ts";
import { threadStore } from "../threads/store.ts";
import { registerFilesCommands } from "./commands.ts";
import { PULT_SCHEME, toUriPath } from "./paths.ts";
import { endedTurns } from "./projects.ts";
import { PultFileSystemProvider, workspaceDecorations } from "./provider.ts";
import { environmentShell, pultFolders, servicesReady, workspaceFiles } from "./workspace.ts";

/**
 * The `pult:` scheme as page code (`pult/decisions`, `pult-uri`): the
 * provider on the workbench's file service, registered before the workbench
 * initialises, so the explorer's restored `pult:` folders and tabs find it
 * (the extension's own provider then fails to register, which only logs),
 * and the workspace's commands. Once the workbench is up, what keeps open
 * files current: the folders' watches where the server has them, synced as
 * the folders change, and turn ends and reconnects everywhere.
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
  (await getService(IWorkspaceContextService)).onDidChangeWorkspaceFolders(() => void workspaceFiles().syncWatches());

  let environmentId: string | undefined;
  let ready = false;
  let completions = new Map<string, number>();
  const followConnection = () => {
    const environment = connection.environment;
    if (environment?.environmentId !== environmentId) {
      environmentId = environment?.environmentId;
      completions = new Map();
    }
    // Changes made while the page was offline went unseen.
    if (environment?.phase === "ready" && !ready) {
      const files = workspaceFiles();
      void files.syncWatches();
      for (const folder of pultFolders()) void files.refresh(folder.uri.path);
      if (provider.failedUnavailable) {
        provider.failedUnavailable = false;
        void getService(ICommandService).then((commands) => commands.executeCommand("workbench.files.action.refreshFilesExplorer"));
      }
    }
    ready = environment?.phase === "ready";
  };
  // A thread's run that finished may have changed files under its root.
  const followTurns = () => {
    if (environmentId === undefined) return;
    const ended = endedTurns(completions, environmentShell());
    completions = ended.seen;
    for (const root of ended.roots) void workspaceFiles().refresh(toUriPath(root));
  };
  connection.onDidChange(followConnection);
  threadStore.subscribe(followTurns);
  followConnection();
  followTurns();
}
