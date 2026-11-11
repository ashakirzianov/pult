import { getService, INotificationService } from "@codingame/monaco-vscode-api";

import { registerConnectionCommands } from "./commands.ts";
import { connection } from "./connection.ts";
import { bindConnectedContext } from "./contextKey.ts";

export { pickEnvironment } from "./commands.ts";
export { connection, environmentName, SERVER_CONFIG_OPTIONS } from "./connection.ts";
export type { ShellEnvironment } from "./connection.ts";
export { ConnectedContext } from "./contextKey.ts";

/**
 * The page's connection: its commands and its context key `pult.connected`
 * (`contextKey.ts`), then the environments saved before a reload reconnect
 * once the workbench's secret storage is up. A reconnect that fails
 * (the desktop's secret store refusing or unreadable, say) says why in a
 * notification, since the page otherwise just starts disconnected.
 */
export function startConnection(): void {
  registerConnectionCommands();
  void bindConnectedContext();
  bindLocalAttribute();
  connection.restore().catch(async (error: unknown) => {
    console.error("[pult-shell] reconnect failed", error);
    const cause = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(
      `Pult could not reconnect to the saved environments. ${cause}`,
    );
  });
}

/**
 * `data-pult-local` on `<html>`: the app's own server's connection,
 * `connected` once it is ready, else its phase; absent without a local server.
 * The release workflow's smoke test (`desktop/scripts/smoke.ts`) waits on it.
 */
function bindLocalAttribute(): void {
  const update = () => {
    const phase = connection.localEnvironment?.phase;
    const root = document.documentElement;
    if (phase === undefined) delete root.dataset.pultLocal;
    else root.dataset.pultLocal = phase === "ready" ? "connected" : phase;
  };
  update();
  connection.onDidChange(update);
}
