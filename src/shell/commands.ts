import { getService, ICommandService } from "@codingame/monaco-vscode-api";

/** Runs a workbench or extension command from Pult's own UI. */
export async function runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined> {
  const commands = await getService(ICommandService);
  try {
    return await commands.executeCommand<T>(id, ...args);
  } catch (error) {
    console.error(`[pult-shell] ${id} failed`, error);
    return undefined;
  }
}
