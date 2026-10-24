import { registerConnectionBridge } from "./bridge.ts";
import { registerConnectionCommands } from "./commands.ts";
import { connection } from "./connection.ts";

export { connection } from "./connection.ts";
export type { ShellEnvironment } from "./connection.ts";

/**
 * The page's connection: its commands and the extension's bridge, registered
 * before the extension starts, then the environment saved before a reload
 * reconnects once the workbench's secret storage is up.
 */
export function startConnection(): void {
  registerConnectionCommands();
  registerConnectionBridge();
  connection.restore().catch((error: unknown) => console.error("[pult-shell] reconnect failed", error));
}
