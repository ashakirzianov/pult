import { getService, INotificationService } from "@codingame/monaco-vscode-api";

import { registerConnectionBridge } from "./bridge.ts";
import { registerConnectionCommands } from "./commands.ts";
import { connection } from "./connection.ts";

export { connection } from "./connection.ts";
export type { ShellEnvironment } from "./connection.ts";

/**
 * The page's connection: its commands and the extension's bridge, registered
 * before the extension starts, then the environment saved before a reload
 * reconnects once the workbench's secret storage is up. A reconnect that fails
 * (the desktop's secret store refusing or unreadable, say) says why in a
 * notification, since the page otherwise just starts disconnected.
 */
export function startConnection(): void {
  registerConnectionCommands();
  registerConnectionBridge();
  connection.restore().catch(async (error: unknown) => {
    console.error("[pult-shell] reconnect failed", error);
    const cause = error instanceof Error ? error.message : String(error);
    (await getService(INotificationService)).error(`Pult could not reconnect to the saved environment. ${cause}`);
  });
}
