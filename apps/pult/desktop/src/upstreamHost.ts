// @effect-diagnostics nodeBuiltinImport:off - Plain Electron handlers, outside upstream's Effect runtime.
/**
 * Pult's part of upstream's desktop main process (`apps/desktop`), Pult.app's
 * host (`pult/decisions`, `desktop-wrapper`): the handlers behind
 * `window.pultDesktop` that the thin wrapper's main answers too (`main.ts`),
 * for the page served under upstream's privileged scheme. Upstream's main
 * calls `installPultDesktop` once its own IPC handlers are in; the preload
 * half is `upstreamPreload.ts`, the names `brand.ts`.
 */
import * as NodePath from "node:path";

import { app, BrowserWindow, ipcMain, webContents, type IpcMainInvokeEvent } from "electron";

import { Channel, titleBarLayout, type Reply } from "./ipc.ts";
import { openSecretStore } from "./secretStore.ts";

/**
 * Answers `window.pultDesktop` for the page at `pageOrigin` (upstream's
 * `<scheme>://app`): the secrets in `userData`'s `secrets.json`, the title
 * bar's layout, the window's full screen, the window kept rendering for a
 * browser's capture, and the app's version. Called after
 * `ready`, once `userData` is set.
 */
export function installPultDesktop(input: { readonly pageOrigin: string }): void {
  const secrets = openSecretStore(NodePath.join(app.getPath("userData"), "secrets.json"));
  const fromPage = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    return frame !== null && frame.parent === null && frame.origin === input.pageOrigin;
  };
  const handle = <T>(
    channel: string,
    answer: (event: IpcMainInvokeEvent, ...args: string[]) => T,
  ) =>
    ipcMain.handle(channel, (event, ...args: unknown[]): Reply<T> => {
      if (!fromPage(event))
        return { ok: false, error: `Pult refused ${channel} from ${event.senderFrame?.origin}.` };
      if (!args.every((arg) => typeof arg === "string"))
        return { ok: false, error: `${channel} takes strings.` };
      try {
        return { ok: true, value: answer(event, ...args) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

  handle(Channel.secretsGet, (_event, key) => secrets.get(key));
  handle(Channel.secretsSet, (_event, key, value) => secrets.set(key, value));
  handle(Channel.secretsDelete, (_event, key) => secrets.delete(key));
  handle(Channel.secretsKeys, () => secrets.keys());
  // Upstream's window places the lights for its own 52px top bar on load, on zoom and on
  // leaving full screen; the page asks again after each, and its answer lands last.
  handle(Channel.windowTitleBarLayout, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { position, room } = titleBarLayout(
      event.sender.getZoomFactor(),
      window?.isFullScreen() ?? false,
    );
    if (process.platform === "darwin") window?.setWindowButtonPosition(position);
    return room;
  });
  // A hidden window, occluded or on another Space, composites nothing once upstream turns
  // its background throttling back on after the first reveal, its webviews included, so an
  // agent's screenshot of a browser waits for a frame that never comes. The page holds this
  // while upstream's host paints a browser for a capture (`view/browserHost.tsx`), seconds
  // per snapshot, and a reloaded page's first `off` drops a hold its predecessor left.
  const rendering = new Set<number>();
  handle(Channel.windowKeepRendering, (event, keep) => {
    const contents = event.sender;
    if (keep === "on") {
      rendering.add(contents.id);
      contents.setBackgroundThrottling(false);
      return;
    }
    if (!rendering.delete(contents.id)) return;
    // Upstream's own frame captures (a recording) unthrottle their guest and the window, and restore both.
    const capturing = webContents
      .getAllWebContents()
      .some((guest) => guest.hostWebContents === contents && !guest.getBackgroundThrottling());
    if (!capturing) contents.setBackgroundThrottling(true);
  });
  ipcMain.on(Channel.version, (event) => {
    event.returnValue = app.getVersion();
  });
  app.on("browser-window-created", (_event, window) => {
    window.on("enter-full-screen", () => window.webContents.send(Channel.windowFullScreen, true));
    window.on("leave-full-screen", () => window.webContents.send(Channel.windowFullScreen, false));
  });
}
