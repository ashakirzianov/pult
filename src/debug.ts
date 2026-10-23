import { getService, ICommandService, IExtensionService, IFileService } from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

import { Uri } from "monaco-editor";

import { threadStore } from "./threads/store.ts";

/** `window.pult`: a handle for driving the spike from the console. */
export function installDebugHandle(): void {
  Object.assign(window, {
    pult: {
      Uri,
      threads: () => threadStore.get(),
      read: async (uri: URI) => {
        const files = await getService(IFileService);
        if (!files.hasProvider(uri)) return { provider: false };
        const file = await files.readFile(uri);
        return { provider: true, size: file.size, text: new TextDecoder().decode(file.value.buffer).slice(0, 200) };
      },
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
