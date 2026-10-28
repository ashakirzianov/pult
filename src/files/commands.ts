import {
  getService,
  ICommandService,
  IEditorService,
  INotificationService,
  IQuickInputService,
  IWorkspaceEditingService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import type { IQuickPickItem, IQuickPickSeparator } from "@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput";
import type { IWorkspaceFolder } from "@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import { request } from "@t3tools/client-runtime/rpc";
import { CommandId, ProjectId, WS_METHODS } from "@t3tools/contracts";

import { connection, ConnectedContext } from "../connection/index.ts";
import { baseName, joinPath, parentOf, toHostPath, toUriPath } from "./paths.ts";
import { type ProjectRoot, projectRoots } from "./projects.ts";
import { connectionServer } from "./server.ts";
import { environmentShell, pultFolders, pultResource } from "./workspace.ts";

const SEARCH_DELAY_MS = 150;
const ENTRY_LIMIT = 50;
const CONTENT_LIMIT = 200;

type FileItem = IQuickPickItem & { readonly resource: URI };
type MatchItem = FileItem & { readonly line: number; readonly start: number; readonly end: number };

/** "Pult: Go to File…": quick open over the server's `searchEntries` in every workspace folder. */
async function goToFile(accessor: ServicesAccessor): Promise<void> {
  const editors = accessor.get(IEditorService);
  await searchPick<FileItem>(
    accessor,
    { placeholder: "Search files by name", searchEmpty: true },
    async (query, folder) => {
      const { entries } = await connectionServer.searchEntries({
        cwd: toHostPath(folder.uri.path),
        query: query.trim().slice(0, 256),
        limit: ENTRY_LIMIT,
        kind: "file",
      });
      return entries.map((entry) => ({
        label: baseName(entry.path),
        description: [folder.name, parentOf(entry.path)].filter((part) => part !== "").join(" · "),
        resource: folder.uri.with({ path: joinPath(folder.uri.path, entry.path) }),
        alwaysShow: true,
      }));
    },
    (item) => editors.openEditor({ resource: item.resource }),
  );
}

/**
 * "Pult: Search in Files…": the server's `searchContents` in every workspace
 * folder, as a quick pick; the workbench's search view needs a search
 * provider for the scheme, which the server's RPCs do not make.
 */
async function searchInFiles(accessor: ServicesAccessor): Promise<void> {
  const editors = accessor.get(IEditorService);
  await searchPick<MatchItem>(
    accessor,
    { placeholder: "Search file contents", searchEmpty: false },
    async (query, folder) => {
      const { matches } = await connectionServer.searchContents({
        cwd: toHostPath(folder.uri.path),
        query: query.slice(0, 256),
        limit: CONTENT_LIMIT,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      return matches.map((match) => {
        const range = match.matchRanges[0];
        return {
          label: match.lineContent.trim(),
          description: `${match.path}:${match.lineNumber}`,
          detail: folder.name,
          resource: folder.uri.with({ path: joinPath(folder.uri.path, match.path) }),
          line: match.lineNumber,
          start: range?.start ?? 0,
          end: range?.end ?? 0,
          alwaysShow: true,
        };
      });
    },
    (item) =>
      editors.openEditor({
        resource: item.resource,
        options: {
          selection: { startLineNumber: item.line, startColumn: item.start + 1, endLineNumber: item.line, endColumn: item.end + 1 },
        },
      }),
  );
}

/** A quick pick that searches the workspace folders as the user types, dropping stale answers. */
async function searchPick<Item extends FileItem>(
  accessor: ServicesAccessor,
  options: { readonly placeholder: string; readonly searchEmpty: boolean },
  search: (query: string, folder: IWorkspaceFolder) => Promise<Array<Item>>,
  open: (item: Item) => Promise<unknown>,
): Promise<void> {
  const folders = pultFolders();
  if (folders.length === 0) {
    accessor.get(INotificationService).info("Pult: open a project first (Pult: Open Project…).");
    return;
  }
  const pick = accessor.get(IQuickInputService).createQuickPick<Item>();
  pick.placeholder = options.placeholder;
  pick.sortByLabel = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (query: string) => {
    const current = ++generation;
    if (query === "" && !options.searchEmpty) {
      pick.items = [];
      pick.busy = false;
      return;
    }
    pick.busy = true;
    const failures: Array<string> = [];
    const results = await Promise.all(
      folders.map((folder) =>
        search(query, folder).catch((error: unknown) => {
          failures.push(error instanceof Error ? error.message : String(error));
          return [];
        }),
      ),
    );
    if (current !== generation) return;
    pick.items = results.flat();
    pick.placeholder = failures[0] ?? options.placeholder;
    pick.busy = false;
  };
  pick.onDidChangeValue((query) => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(query), SEARCH_DELAY_MS);
  });
  pick.onDidAccept(() => {
    const [item] = pick.selectedItems;
    if (item === undefined) return;
    pick.hide();
    void open(item);
  });
  pick.onDidHide(() => {
    clearTimeout(timer);
    pick.dispose();
  });
  pick.show();
  void run("");
}

type ProjectItem = IQuickPickItem & { readonly root?: ProjectRoot; readonly create?: string };

/** A host path typed into Open Project, which it offers to add as a project. */
const HOST_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

/**
 * "Pult: Open Project…": a project of the environment, or a worktree its
 * threads run in, added as a workspace folder; or a path typed in, added to
 * the environment as a project first, as upstream's Add Project does.
 */
async function openProject(accessor: ServicesAccessor): Promise<void> {
  const commands = accessor.get(ICommandService);
  const environment = connection.environment;
  if (environment === null) return void commands.executeCommand("pult-shell.connect");
  const quickInput = accessor.get(IQuickInputService);
  const notifications = accessor.get(INotificationService);
  const roots = projectRoots(environmentShell());
  const listed: Array<ProjectItem | IQuickPickSeparator> = [];
  for (const root of roots) {
    if (root.worktree === null) listed.push({ type: "separator", label: root.project });
    listed.push({
      label: root.worktree === null ? `$(repo) ${root.project}` : `$(git-branch) ${root.worktree}`,
      description: root.path,
      root,
    });
  }
  const pick = quickInput.createQuickPick<ProjectItem>({ useSeparators: true });
  pick.placeholder = `Open a project of ${environment.label} as a workspace folder, or type a folder's path to add it as a project`;
  pick.matchOnDescription = true;
  pick.items = listed;
  pick.onDidChangeValue((value) => {
    const path = value.trim();
    const known = roots.some((root) => root.path === path);
    pick.items =
      HOST_PATH.test(path) && !known
        ? [{ label: `$(add) Add ${path} as a project`, create: path, alwaysShow: true }, ...listed]
        : listed;
  });
  const picked = await new Promise<ProjectItem | undefined>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
  if (picked === undefined) return;
  let folder: { uri: URI; name: string };
  if (picked.root !== undefined) {
    folder = { uri: pultResource(toUriPath(picked.root.path)), name: picked.root.name };
  } else if (picked.create !== undefined) {
    try {
      const project = await connection.run(
        request(
          WS_METHODS.projectsMutate,
          buildProjectCreateCommand({
            commandId: CommandId.make(crypto.randomUUID()),
            projectId: ProjectId.make(crypto.randomUUID()),
            workspaceRoot: picked.create,
          }),
        ),
      );
      folder = { uri: pultResource(toUriPath(project.workspaceRoot)), name: project.title };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return void notifications.error(`Pult could not add ${picked.create} as a project: ${message}`);
    }
  } else return;
  if (pultFolders().some((existing) => existing.uri.path === folder.uri.path)) {
    return void commands.executeCommand("revealInExplorer", folder.uri);
  }
  await (await getService(IWorkspaceEditingService)).addFolders([folder]);
}

/**
 * The workspace's commands, in the palette under Pult; Go to File and Search
 * in Files take Cmd+P and Cmd+Shift+F while the page holds an environment,
 * over the extension's bindings of its own versions while it still has them.
 */
export function registerFilesCommands(): void {
  const category = { value: "Pult", original: "Pult" };
  const weight = KeybindingWeight.ExternalExtension + 1;
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.goToFile",
          title: { value: "Go to File…", original: "Go to File…" },
          category,
          f1: true,
          precondition: ConnectedContext,
          keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyP, when: ConnectedContext, weight },
        });
      }

      run(accessor: ServicesAccessor): Promise<void> {
        return goToFile(accessor);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.searchInFiles",
          title: { value: "Search in Files…", original: "Search in Files…" },
          category,
          f1: true,
          precondition: ConnectedContext,
          keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF, when: ConnectedContext, weight },
        });
      }

      run(accessor: ServicesAccessor): Promise<void> {
        return searchInFiles(accessor);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openProject",
          title: { value: "Open Project…", original: "Open Project…" },
          category,
          f1: true,
        });
      }

      run(accessor: ServicesAccessor): Promise<void> {
        return openProject(accessor);
      }
    },
  );
}
