import {
  getService,
  INotificationService,
  IWorkspaceContextService,
} from "@codingame/monaco-vscode-api";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import type { ServicesAccessor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation";
import { request } from "@t3tools/client-runtime/rpc";
import { type FileManagerRevealKind, type ServerConfig, WS_METHODS } from "@t3tools/contracts";

import { connection } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import { PULT_SCHEME, toHostPath } from "./paths.ts";

const REVEAL_COMMAND = "pult-shell.revealInFileManager";

/** Upstream's words per kind (`apps/web/src/components/preview/fileExplorerLabel.ts`), duplicated rather than imported. */
const WORDS: Record<FileManagerRevealKind, string> = {
  finder: "Finder",
  "file-explorer": "File Explorer",
  files: "Files",
};

/** Pult.app's own server while its config says it reveals, and the kind of file manager it reveals in. */
export interface LocalFileManager {
  readonly environmentId: string;
  readonly kind: FileManagerRevealKind;
  /** `Open in Finder` (File Explorer, Files), a folder's own action. */
  readonly openTitle: string;
}

/** The kind of file manager a server reveals in, undefined while it does not reveal. */
function revealKind(config: ServerConfig): FileManagerRevealKind | undefined {
  if (config.shellRevealInFileManager !== true) return undefined;
  if (!config.availableEditors.includes("file-manager")) return undefined;
  return config.shellRevealInFileManagerKind;
}

let local: LocalFileManager | undefined;
const listeners = new Set<() => void>();

/**
 * This machine's file manager, `connection.localEnvironment` while its config
 * says it reveals (`pult/decisions`, `file-manager-reveal`), undefined
 * otherwise: another environment's server would open the window on another
 * computer, so its items show nothing, as upstream hides its Open in row; a
 * loopback address in a browser tab is not this machine either, since it may
 * be a tunnel. Followed from `registerRevealInFileManager` on.
 */
export const localFileManager = {
  get: (): LocalFileManager | undefined => local,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function followLocalFileManager(): void {
  let followed: { environmentId: string; stop: () => void } | undefined;
  const publish = (environmentId: string | undefined, kind: FileManagerRevealKind | undefined) => {
    const next =
      environmentId === undefined || kind === undefined
        ? undefined
        : { environmentId, kind, openTitle: `Open in ${WORDS[kind]}` };
    if (next?.environmentId === local?.environmentId && next?.kind === local?.kind) return;
    local = next;
    for (const listener of listeners) listener();
  };
  const follow = () => {
    const id = connection.localEnvironment?.environmentId;
    if (id === followed?.environmentId) return;
    followed?.stop();
    followed = undefined;
    publish(undefined, undefined);
    if (id === undefined) return;
    const stop = followServerConfig(id, (config) => publish(id, revealKind(config)));
    followed = { environmentId: id, stop };
  };
  connection.onDidChange(follow);
  follow();
}

/**
 * Opens `path` in this machine's file manager, the folder itself, or with
 * `reveal` the item selected in its parent, through the server's
 * `shell.openInEditor` with `file-manager`; a failure (the path gone, no file
 * manager) is a notification with the server's message.
 */
export async function openInFileManager(
  environmentId: string,
  path: string,
  options: { readonly reveal: boolean },
): Promise<void> {
  try {
    await connection.run(
      environmentId,
      request(WS_METHODS.shellOpenInEditor, {
        cwd: path,
        editor: "file-manager",
        ...(options.reveal ? { reveal: true } : {}),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notifications = await getService(INotificationService);
    notifications.error(`Pult could not ${options.reveal ? "reveal" : "open"} ${path}: ${message}`);
  }
}

/** The Explorer's Reveal in Finder (File Explorer, Files) on any file or folder of this machine's server (`localFileManager`). */
export function registerRevealInFileManager(): void {
  let registered: { manager: LocalFileManager; action: IDisposable } | undefined;
  const register = () => {
    const manager = local;
    if (registered?.manager === manager) return;
    registered?.action.dispose();
    registered = undefined;
    if (manager === undefined) return;
    registered = { manager, action: registerReveal(manager.environmentId, manager.kind) };
  };
  localFileManager.subscribe(register);
  followLocalFileManager();
  register();
}

function registerReveal(environmentId: string, kind: FileManagerRevealKind): IDisposable {
  const title = `Reveal in ${WORDS[kind]}`;
  const prefix = `${PULT_SCHEME}://${environmentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
  return registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: REVEAL_COMMAND,
          title: { value: title, original: title },
          f1: false,
          menu: {
            id: MenuId.ExplorerContext,
            group: "navigation",
            when: ContextKeyExpr.regex("resource", new RegExp(`^${prefix}`, "i")),
          },
        });
      }

      async run(accessor: ServicesAccessor, arg: unknown): Promise<void> {
        // A right-click on the Explorer's empty space with several folders passes `{}`, its `resource` key the last folder (VS Code's `explorerView.ts`, `setContextKeys`).
        const resource = isEmptySpace(arg)
          ? accessor.get(IWorkspaceContextService).getWorkspace().folders.at(-1)?.uri
          : arg;
        // The menu shows only for this environment's items; anything else came by `executeCommand`.
        if (
          !URI.isUri(resource) ||
          resource.scheme !== PULT_SCHEME ||
          resource.authority.toLowerCase() !== environmentId.toLowerCase()
        ) {
          throw new Error(
            `${REVEAL_COMMAND} reveals only a pult: resource of this machine's environment ${environmentId}, not ${String(resource)}.`,
          );
        }
        await openInFileManager(environmentId, toHostPath(resource.path), { reveal: true });
      }
    },
  );
}

/** The Explorer's empty space's argument, an empty plain object. */
function isEmptySpace(arg: unknown): boolean {
  return (
    typeof arg === "object" &&
    arg !== null &&
    Object.getPrototypeOf(arg) === Object.prototype &&
    Object.keys(arg).length === 0
  );
}
