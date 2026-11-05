import { getService, IContextKeyService, IDialogService } from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

import { desktopHost } from "./host.ts";

/**
 * Pult.app's local server (`pult/decisions`, `local-server`): upstream's
 * desktop setting `localEnvironmentEnabled`, on by default; off, the app
 * starts no server and is a client of other environments alone. The value is
 * the one the app started with, since a change relaunches it. `undefined`
 * outside Pult.app, where the page runs no server either way.
 */
export function localServerEnabled(): boolean | undefined {
  return desktopHost()?.getLocalEnvironmentEnabled();
}

/** `on` or `off` in Pult.app, empty elsewhere, for the palette's Turn On and Turn Off Local Server. */
const LocalServerContext = new RawContextKey<string>("pult.localServer", "");

/** Asks, then turns the local server on or off, which relaunches Pult.app. */
export async function setLocalServerEnabled(enabled: boolean): Promise<void> {
  const host = desktopHost();
  if (host === undefined || localServerEnabled() === enabled) return;
  const { confirmed } = await (
    await getService(IDialogService)
  ).confirm({
    message: enabled ? "Turn on the local server?" : "Turn off the local server?",
    detail: enabled
      ? "Pult restarts and runs a server on this computer again."
      : "Pult restarts without running a server on this computer. Agents and terminals running here stop, and other devices can no longer connect to it. Other environments are unaffected.",
    primaryButton: enabled ? "Restart and Turn On" : "Restart and Turn Off",
  });
  if (confirmed) await host.setLocalEnvironmentEnabled(enabled);
}

/** Registers the palette's Pult: Turn On Local Server and Turn Off Local Server. Called before the workbench starts. */
export function registerLocalServerCommands(): void {
  for (const enabled of [true, false]) {
    const verb = enabled ? "On" : "Off";
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: `pult-shell.turn${verb}LocalServer`,
            title: { value: `Turn ${verb} Local Server`, original: `Turn ${verb} Local Server` },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            precondition: LocalServerContext.isEqualTo(enabled ? "off" : "on"),
          });
        }

        run(): Promise<void> {
          return setLocalServerEnabled(enabled);
        }
      },
    );
  }
}

/** Sets the context key from the setting the app started with. */
export async function startLocalServerContext(): Promise<void> {
  const enabled = localServerEnabled();
  if (enabled === undefined) return;
  LocalServerContext.bindTo(await getService(IContextKeyService)).set(enabled ? "on" : "off");
}
