import { getService, IFileService, INotificationService, IQuickInputService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import type { IQuickPickItem } from "@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { checkoutName, checkoutsOf } from "../changes/checkouts.ts";
import { baseName, namesEnvironment, parentOf, toHostPath } from "../files/paths.ts";
import { type Candidate, resolveThreadPath } from "../files/resolve.ts";
import { environmentServer } from "../files/server.ts";
import { pultResource, whenListed } from "../files/workspace.ts";
import { threadStore } from "./store.ts";

/** As many entries as Go to File asks each root for. */
const ENTRY_LIMIT = 50;

/**
 * Opens a file the thread view names as an editor tab, where upstream would
 * show it in the view's right panel: `path` relative to the thread's
 * checkout, its worktree else its project's root, or an absolute host path,
 * at `line` when given. Resolved by `resolveThreadPath` (`src/files/resolve.ts`):
 * the literal path when the checkout has it, else the files of the thread's
 * checkout whose path ends with it, else of the environment's other
 * checkouts, through the server's index, a quick pick among several. The tab
 * goes beside the thread's, in the active group, as a preview that a second
 * file replaces; the page's `pult:` provider serves it (`src/files/`). No
 * match, or an absolute path under no checkout, is a notice rather than an
 * editor that fails to open.
 */
export async function openThreadFile(environmentId: string, threadId: string, path: string, line: number | null): Promise<void> {
  if (threadStore.thread(environmentId, threadId) === undefined) return;
  const [files, editors, notifications, quickInput] = await Promise.all([
    getService(IFileService),
    getService(IEditorService),
    getService(INotificationService),
    getService(IQuickInputService),
    whenListed(environmentId),
  ]);
  const thread = threadStore.thread(environmentId, threadId);
  if (thread === undefined) return;
  const state = threadStore.get();
  const ofEnvironment = <Item extends { readonly environmentId: string }>(items: ReadonlyArray<Item>) =>
    items.filter((item) => namesEnvironment(item.environmentId, environmentId));
  const resolution = await resolveThreadPath({
    path,
    checkoutRoot: thread.checkoutRoot ?? thread.projectRoot,
    projectId: thread.projectId,
    checkouts: checkoutsOf({ projects: ofEnvironment(state.projects), threads: ofEnvironment(state.threads) }),
    exists: (candidate) => files.exists(pultResource(environmentId, candidate)).catch(() => false),
    search: async (checkout, key) => {
      const { entries } = await environmentServer(environmentId).searchEntries({
        cwd: toHostPath(checkout.root),
        query: key.slice(0, 256),
        limit: ENTRY_LIMIT,
        kind: "file",
      });
      return entries.map((entry) => entry.path);
    },
  });
  let opened: string | undefined;
  switch (resolution.kind) {
    case "outside":
      return void notifications.warn(`Pult opens files only under the environment's projects: ${path}.`);
    case "missing": {
      const of = threadStore.distinguishing(environmentId);
      const where = `${thread.projectName} or any other project${of === undefined ? "" : ` of ${of}`}`;
      const failed = resolution.error === undefined ? "" : ` The search failed: ${resolution.error}`;
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
    options: line === null ? {} : { selection: { startLineNumber: line, startColumn: 1 } },
  });
}

/** The quick pick among several files ending with the key, in Go to File's shape; Escape picks none. */
async function pickCandidate(quickInput: IQuickInputService, key: string, candidates: ReadonlyArray<Candidate>): Promise<string | undefined> {
  const items = candidates.map((candidate) => ({
    label: baseName(candidate.relativePath),
    description: [checkoutName(candidate.checkout), parentOf(candidate.relativePath)].filter((part) => part !== "").join(" · "),
    path: candidate.path,
  })) satisfies Array<IQuickPickItem & { readonly path: string }>;
  const picked = await quickInput.pick(items, { placeHolder: `Open which ${key}?`, matchOnDescription: true });
  return picked?.path;
}

/**
 * `pult-shell.openThreadFile <environmentId> <threadId> <path> [line]`, what
 * a file link in the thread view does, for `window.pult.exec` and
 * `scripts/drive.ts`; not in the palette, whose way to a file is Go to File.
 */
export function registerOpenThreadFileCommand(): void {
  CommandsRegistry.registerCommand("pult-shell.openThreadFile", (_accessor, environmentId: unknown, threadId: unknown, path: unknown, line: unknown) => {
    if (typeof environmentId !== "string" || typeof threadId !== "string" || typeof path !== "string") return;
    return openThreadFile(environmentId, threadId, path, typeof line === "number" ? line : null);
  });
}
