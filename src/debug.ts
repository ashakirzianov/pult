import {
  getService,
  ICommandService,
  IEditorGroupsService,
  IExtensionService,
  IFileService,
} from "@codingame/monaco-vscode-api";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { GroupsOrder } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";

import { Uri } from "monaco-editor";

import { changesState } from "./changes/view.ts";
import { connection } from "./connection/index.ts";
import { selectedDraft, selectedThread } from "./threads/selection.ts";
import { threadStore } from "./threads/store.ts";

/** `window.pult`: a handle for driving the spike from the console. */
export function installDebugHandle(): void {
  Object.assign(window, {
    pult: {
      Uri,
      connection: () => connection.environment,
      threads: () => threadStore.get(),
      selected: () => selectedThread() ?? selectedDraft(),
      // What the changes view shows and why: its thread, root, group sizes and last failure.
      changes: () => changesState(),
      // The editor part's tabs, per group in grid order; `*` marks the active one.
      tabs: async () =>
        (await getService(IEditorGroupsService)).getGroups(GroupsOrder.GRID_APPEARANCE).map((group) =>
          group.editors.map((editor) => `${group.isActive(editor) ? "*" : ""}${editor.getName()}`),
        ),
      read: async (uri: URI) => {
        const files = await getService(IFileService);
        if (!files.hasProvider(uri)) return { provider: false };
        const file = await files.readFile(uri);
        return { provider: true, size: file.size, text: new TextDecoder().decode(file.value.buffer).slice(0, 200) };
      },
      exec: async (id: string, ...args: unknown[]) => (await getService(ICommandService)).executeCommand(id, ...args),
      commands: (prefix = "pult.") => [...CommandsRegistry.getCommands().keys()].filter((id) => id.startsWith(prefix)),
      // What VS Code's "Developer: Restart Extension Host" does, which this workbench does not register.
      restartExtensionHost: async () => {
        const service = await getService(IExtensionService);
        if (await service.stopExtensionHosts("window.pult")) await service.startExtensionHosts();
      },
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
