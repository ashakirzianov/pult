import { INotificationService, IWorkspaceContextService } from "@codingame/monaco-vscode-api";
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

/** Upstream's labels per kind (`apps/web/src/components/preview/fileExplorerLabel.ts`), duplicated rather than imported. */
const TITLES: Record<FileManagerRevealKind, string> = {
  finder: "Reveal in Finder",
  "file-explorer": "Reveal in File Explorer",
  files: "Reveal in Files",
};

/** The kind of file manager a server reveals in, undefined while it does not reveal. */
function revealKind(config: ServerConfig): FileManagerRevealKind | undefined {
  if (config.shellRevealInFileManager !== true) return undefined;
  if (!config.availableEditors.includes("file-manager")) return undefined;
  return config.shellRevealInFileManagerKind;
}

/**
 * The Explorer's Reveal in Finder (File Explorer, Files) on any file or folder
 * of Pult.app's own server, `connection.localEnvironment`, while its config
 * says it reveals (`pult/decisions`, `file-manager-reveal`). Another
 * environment's server would open the window on another computer, so its
 * items show nothing, as upstream hides its Open in row; a loopback address in
 * a browser tab is not this machine either, since it may be a tunnel.
 */
export function registerRevealInFileManager(): void {
  let followed: { environmentId: string; stop: () => void } | undefined;
  let registered:
    | { environmentId: string; kind: FileManagerRevealKind; action: IDisposable }
    | undefined;
  const register = (environmentId: string | undefined, kind: FileManagerRevealKind | undefined) => {
    if (registered?.environmentId === environmentId && registered?.kind === kind) return;
    registered?.action.dispose();
    registered = undefined;
    if (environmentId === undefined || kind === undefined) return;
    registered = { environmentId, kind, action: registerReveal(environmentId, kind) };
  };
  const follow = () => {
    const local = connection.localEnvironment?.environmentId;
    if (local === followed?.environmentId) return;
    followed?.stop();
    followed = undefined;
    register(undefined, undefined);
    if (local === undefined) return;
    const stop = followServerConfig(local, (config) => register(local, revealKind(config)));
    followed = { environmentId: local, stop };
  };
  connection.onDidChange(follow);
  follow();
}

function registerReveal(environmentId: string, kind: FileManagerRevealKind): IDisposable {
  const title = TITLES[kind];
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
        const notifications = accessor.get(INotificationService);
        const path = toHostPath(resource.path);
        try {
          await connection.run(
            environmentId,
            request(WS_METHODS.shellOpenInEditor, {
              cwd: path,
              editor: "file-manager",
              reveal: true,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notifications.error(`Pult could not reveal ${path}: ${message}`);
        }
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
