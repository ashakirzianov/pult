import { getService, IContextKeyService } from "@codingame/monaco-vscode-api";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

import { connection } from "./connection.ts";

/**
 * `pult.connected`: whether the page holds an environment, whatever its
 * phase, for the keybindings and menus of commands that need one. The
 * extension's `pult.bound` says the same of its own window binding.
 */
export const ConnectedContext = new RawContextKey<boolean>("pult.connected", false);

/** Keeps `pult.connected` to the connection once the workbench's services are up. */
export async function bindConnectedContext(): Promise<void> {
  const key = ConnectedContext.bindTo(await getService(IContextKeyService));
  const update = () => key.set(connection.environment !== null);
  update();
  connection.onDidChange(update);
}
