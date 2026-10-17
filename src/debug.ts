import { getService, ICommandService, IExtensionService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

/** `window.pult`: a handle for driving the spike from the console. */
export function installDebugHandle(): void {
  Object.assign(window, {
    pult: {
      exec: async (id: string, ...args: unknown[]) => (await getService(ICommandService)).executeCommand(id, ...args),
      commands: (prefix = "pult.") => [...CommandsRegistry.getCommands().keys()].filter((id) => id.startsWith(prefix)),
      extensions: async () => (await getService(IExtensionService)).extensions.map((e) => e.identifier.value),
      status: async () => {
        const service = await getService(IExtensionService);
        return Object.fromEntries(
          Object.entries(service.getExtensionsStatus()).map(([id, s]) => [
            id,
            { activated: s.activationTimes !== undefined, messages: s.messages.map((m) => m.message), errors: s.runtimeErrors.map((e) => e.message) },
          ]),
        );
      },
    },
  });
}
