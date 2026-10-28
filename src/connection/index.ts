import { getService, INotificationService } from "@codingame/monaco-vscode-api";

import { registerConnectionCommands } from "./commands.ts";
import { connection } from "./connection.ts";
import { bindConnectedContext } from "./contextKey.ts";

export { pickEnvironment } from "./commands.ts";
export { connection, environmentName } from "./connection.ts";
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
  connection.restore().catch(async (error: unknown) => {
    console.error("[pult-shell] reconnect failed", error);
    const cause = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(`Pult could not reconnect to the saved environments. ${cause}`);
  });
}
