import {
  getService,
  IFileService,
  INotificationService,
  IQuickInputService,
} from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import type { IQuickPickItem } from "@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput";
import { DEFAULT_EDITOR_ASSOCIATION } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { request } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";

import { type Checkout, checkoutName, checkoutsOf } from "../changes/checkouts.ts";
import { keptRoot, onDidChangeKept } from "../changes/kept.ts";
import { connection } from "../connection/index.ts";
import { makeFileLinks } from "../files/linkable.ts";
import {
  baseName,
  locate,
  namesEnvironment,
  parentOf,
  toHostPath,
  toUriPath,
} from "../files/paths.ts";
import { type Candidate, type ResolveInput, resolveThreadPath } from "../files/resolve.ts";
import { environmentServer } from "../files/server.ts";
import { pultResource, whenListed } from "../files/workspace.ts";
import { isHiddenProject } from "../stars/hidden.ts";
import { type ShellThread, threadStore } from "./store.ts";

/** As many entries as Go to File asks each root for. */
const ENTRY_LIMIT = 50;

/**
 * Opens a file the thread view names as an editor tab, where upstream would
 * show it in the view's right panel: `path` relative to the thread's
 * checkout, its worktree else its project's root, or an absolute host path,
 * at `line` when given, in the text editor whatever the file's default, the
 * lines to `endLine` selected when given (a citation's). Resolved by `resolveThreadPath` (`src/files/resolve.ts`):
 * the literal path when the checkout has it, else the files of the thread's
 * checkout whose path ends with it, else of the environment's other
 * checkouts, through the server's index, a quick pick among several; an
 * absolute path under no checkout, from the xaxis root in the environment's
 * kept xaxis checkout. The tab
 * goes beside the thread's, in the active group, as a preview that a second
 * file replaces; the page's `pult:` provider serves it (`src/files/`). No
 * match, or an absolute path under no checkout, is a notice rather than an
 * editor that fails to open.
 */
export async function openThreadFile(
  environmentId: string,
  threadId: string,
  path: string,
  line: number | null,
  endLine: number | null,
): Promise<void> {
  if (threadStore.thread(environmentId, threadId) === undefined) return;
  // A browser tab's citation of a page names its URL (`src/composer/cite.ts`), which no checkout holds.
  if (/^https?:/i.test(path))
    return void (await getService(INotificationService)).info(
      "This citation names a page, not a file.",
    );
  const [files, editors, notifications, quickInput] = await Promise.all([
    getService(IFileService),
    getService(IEditorService),
    getService(INotificationService),
    getService(IQuickInputService),
    whenListed(environmentId),
  ]);
  const thread = threadStore.thread(environmentId, threadId);
  if (thread === undefined) return;
  const resolution = await resolveThreadPath({
    ...threadPathInput(environmentId, thread),
    path,
    exists: (candidate) => files.exists(pultResource(environmentId, candidate)).catch(() => false),
  });
  let opened: string | undefined;
  switch (resolution.kind) {
    case "outside":
      return void notifications.warn(
        `Pult opens files only under the environment's projects: ${path}.`,
      );
    case "missing": {
      const of = threadStore.distinguishing(environmentId);
      const where = `${thread.projectName} or any other project${of === undefined ? "" : ` of ${of}`}`;
      const failed =
        resolution.error === undefined ? "" : ` The search failed: ${resolution.error}`;
      return void notifications.warn(`No ${resolution.key} in ${where}.${failed}`);
    }
    case "open":
      opened = resolution.path;
      break;
    case "pick":
      opened = await pickCandidate(quickInput, resolution.key, resolution.candidates);
      break;
  }
  if (opened === undefined) return;
  await editors.openEditor({
    resource: pultResource(environmentId, opened),
    options:
      line === null
        ? {}
        : {
            override: DEFAULT_EDITOR_ASSOCIATION.id,
            // A selection to the next line's start takes the last line whole, as Cite reads it back.
            selection:
              endLine === null
                ? { startLineNumber: line, startColumn: 1 }
                : {
                    startLineNumber: line,
                    startColumn: 1,
                    endLineNumber: endLine + 1,
                    endColumn: 1,
                  },
          },
  });
}

/** What a path the thread names resolves with but the path and `exists`: the click's, and the file link gate's (`threadFileLinks`). */
function threadPathInput(environmentId: string, thread: ShellThread) {
  return pathInput(environmentId, thread.checkoutRoot ?? thread.projectRoot, thread.projectId);
}

/**
 * What a path a document the reader shows names resolves with but the path
 * and `exists`, as a thread's would in the checkout holding the document, the
 * innermost, else in the project holding it, as a thread of a hidden project
 * (an ask's folder, a Star's) resolves in its own; with neither, in the
 * environment's checkouts alone.
 */
export function documentPathInput(environmentId: string, documentPath: string) {
  const input = pathInput(environmentId, null, "");
  const projects = threadStore
    .get()
    .projects.filter((project) => namesEnvironment(project.environmentId, environmentId));
  const owners = [
    ...input.checkouts.map((checkout) => ({ root: checkout.root, projectId: checkout.projectId })),
    ...projects.flatMap((project) =>
      project.root === null ? [] : [{ root: project.root, projectId: project.id }],
    ),
  ];
  const root = locate(
    owners.map((owner) => toUriPath(owner.root)),
    documentPath,
  )?.root;
  const own = owners.find((owner) => toUriPath(owner.root) === root);
  return own === undefined ? input : { ...input, checkoutRoot: own.root, projectId: own.projectId };
}

function pathInput(environmentId: string, checkoutRoot: string | null, projectId: string) {
  return {
    checkoutRoot,
    projectId,
    checkouts: environmentCheckouts(environmentId),
    xaxisRoot: keptRoot(environmentId),
    search: async (checkout: Checkout, key: string) => {
      const { entries } = await environmentServer(environmentId).searchEntries({
        cwd: toHostPath(checkout.root),
        query: key.slice(0, 256),
        limit: ENTRY_LIMIT,
        kind: "file",
      });
      return entries.map((entry) => entry.path);
    },
  } satisfies Omit<ResolveInput, "path" | "exists">;
}

function environmentCheckouts(environmentId: string) {
  const state = threadStore.get();
  const ofEnvironment = <Item extends { readonly environmentId: string }>(
    items: ReadonlyArray<Item>,
  ) => items.filter((item) => namesEnvironment(item.environmentId, environmentId));
  return checkoutsOf(
    { projects: ofEnvironment(state.projects), threads: ofEnvironment(state.threads) },
    isHiddenProject,
  );
}

/**
 * Whether the view's file chips open anything (`src/files/linkable.ts`), on
 * the click's inputs, the literal paths through the server's
 * `filesystem.getMetadata`; the view's host serves it as `fileLinks`.
 */
export const threadFileLinks = makeFileLinks({
  whenListed,
  input: (environmentId, threadId) => {
    const thread = threadStore.thread(environmentId, threadId);
    return thread === undefined ? undefined : threadPathInput(environmentId, thread);
  },
  getMetadata: async (environmentId, paths) =>
    (
      await connection.run(
        environmentId,
        request(WS_METHODS.filesystemGetMetadata, { paths: [...paths] }),
      )
    ).entries,
  runEnd: (environmentId, threadId) =>
    threadStore.thread(environmentId, threadId)?.latestRun?.finishedAt ?? null,
  // A verdict's swap restyles the whole thread view, some 150 ms in a 300-path thread: a second's worth go at once.
  publishMs: 1000,
  roots: (environmentId) =>
    JSON.stringify([
      environmentCheckouts(environmentId).map((checkout) => checkout.root),
      keptRoot(environmentId),
    ]),
  onDidChange: (listener) => {
    threadStore.subscribe(listener);
    onDidChangeKept(listener);
  },
});

/** The quick pick among several files ending with the key, in Go to File's shape; Escape picks none. */
async function pickCandidate(
  quickInput: IQuickInputService,
  key: string,
  candidates: ReadonlyArray<Candidate>,
): Promise<string | undefined> {
  const items = candidates.map((candidate) => ({
    label: baseName(candidate.relativePath),
    description: [checkoutName(candidate.checkout), parentOf(candidate.relativePath)]
      .filter((part) => part !== "")
      .join(" · "),
    path: candidate.path,
  })) satisfies Array<IQuickPickItem & { readonly path: string }>;
  const picked = await quickInput.pick(items, {
    placeHolder: `Open which ${key}?`,
    matchOnDescription: true,
  });
  return picked?.path;
}

/**
 * `pult-shell.openThreadFile <environmentId> <threadId> <path> [line] [endLine]`,
 * what a file link in the thread view does, or a citation's lines, for `window.pult.exec` and
 * `scripts/drive.ts`; not in the palette, whose way to a file is Go to File.
 */
export function registerOpenThreadFileCommand(): void {
  CommandsRegistry.registerCommand(
    "pult-shell.openThreadFile",
    (
      _accessor,
      environmentId: unknown,
      threadId: unknown,
      path: unknown,
      line: unknown,
      endLine: unknown,
    ) => {
      if (
        typeof environmentId !== "string" ||
        typeof threadId !== "string" ||
        typeof path !== "string"
      )
        return;
      const number = (value: unknown) => (typeof value === "number" ? value : null);
      return openThreadFile(environmentId, threadId, path, number(line), number(endLine));
    },
  );
}
