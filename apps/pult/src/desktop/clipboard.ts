import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { BrowserClipboardService } from "@codingame/monaco-vscode-api/vscode/vs/platform/clipboard/browser/clipboardService";
import type { ExplorerItem } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/common/explorerModel";
import { ExplorerService } from "@codingame/monaco-vscode-explorer-service-override/vscode/vs/workbench/contrib/files/browser/explorerService";

import { connection } from "../connection/index.ts";
import { isLoopback } from "../connection/probe.ts";
import { toUriPath } from "../files/paths.ts";
import { pultResource } from "../files/workspace.ts";

/**
 * The workbench's clipboard (`src/services.ts`), which takes the files
 * desktop VS Code's explorer copied as its resources while it holds none of
 * its own, so the stock explorer Paste pastes them, Cmd+V and the context
 * menu alike (xaxis `pult/tasks/paste-files-copied-in-vscode.task`). Only the
 * desktop reads them (`window.pultDesktop.clipboard`); in a browser tab it is
 * the stock service. None while the explorer's last Cut or Copy was a Cut,
 * since the stock Paste then moves what it is handed (`cutPending`).
 */
export class PultClipboardService extends BrowserClipboardService {
  override async readResources(): Promise<URI[]> {
    const own = await super.readResources();
    return own.length > 0 ? own : await copiedFiles();
  }

  override async hasResources(): Promise<boolean> {
    return (await super.hasResources()) || (await copiedFiles()).length > 0;
  }
}

/**
 * The files desktop VS Code copied, each the `pult:` file of the environment
 * on this machine, whose host paths they are; none while the page holds no
 * such environment.
 */
async function copiedFiles(): Promise<URI[]> {
  if (cutPending) return [];
  const copied = (await window.pultDesktop?.clipboard.readFiles()) ?? [];
  const files = copied.map((uri) => URI.parse(uri)).filter((uri) => uri.scheme === "file");
  if (files.length === 0) return [];
  const environmentId = thisMachine();
  return environmentId === undefined
    ? []
    : files.map((file) => pultResource(environmentId, toUriPath(file.fsPath)));
}

/**
 * The held environment on this machine: Pult.app's own server, the primary
 * (`pult/decisions`, `primary-environment`), while it is held, else the one
 * on a loopback host.
 */
function thisMachine(): string | undefined {
  const primary = connection.localEnvironment;
  if (primary !== undefined) return primary.environmentId;
  const local = connection.environments.filter(
    (environment) =>
      URL.canParse(environment.httpBaseUrl) &&
      isLoopback(new URL(environment.httpBaseUrl).hostname),
  );
  if (local.length > 1) todo("a copied file with several environments on loopback and no primary");
  return local[0]?.environmentId;
}

/**
 * Whether the stock Paste would move: from the explorer's Cut until its next
 * Copy or a Paste, Escape's cancel of the cut included, as the stock handlers'
 * own `pasteShouldMove` holds (`fileActions.ts`), which no service exposes.
 */
let cutPending = false;

/** The workbench's explorer service, telling the clipboard whether a cut is pending (`src/services.ts`). */
export class PultExplorerService extends ExplorerService {
  override async setToCopy(items: ExplorerItem[], cut: boolean): Promise<void> {
    cutPending = cut;
    await super.setToCopy(items, cut);
  }
}

/** What the clipboard does not do yet, loud where it is asked for: `grep 'todo('` lists it. */
function todo(reason: string): never {
  throw new Error(`todo: ${reason}`);
}
