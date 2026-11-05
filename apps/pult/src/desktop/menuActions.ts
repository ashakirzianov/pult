import { getService, ICommandService } from "@codingame/monaco-vscode-api";

import { desktopHost } from "./host.ts";

/**
 * Upstream's menu actions (`apps/desktop`'s application menu, and keys the
 * preview forwards) that name one of the shell's commands: Settings… (Cmd+,)
 * opens Pult's settings page, New Thread Pult's pick. The thread view answers
 * its own, Paste as Text among them, while it is mounted.
 */
const COMMANDS: Readonly<Record<string, string>> = {
  "open-settings": "pult-shell.selectSettings",
  "new-thread": "pult-shell.newThread",
};

/** In Pult.app, runs the shell's command for each menu action that names one. */
export function startMenuActions(): void {
  desktopHost()?.onMenuAction((action) => {
    const command = COMMANDS[action];
    if (command === undefined) return;
    void getService(ICommandService).then((commands) => commands.executeCommand(command));
  });
}
