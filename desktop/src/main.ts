/**
 * The desktop wrapper's main process: one window on the shell page, under the
 * dev identity of `src/identity.ts`, with the page's secrets and the window's
 * state kept in `userData`. Development only so far: the page is the Vite dev
 * server's (`pnpm dev`, http://localhost:5190), or the one `PULT_DEV_SERVER_URL`
 * names for a run beside another; serving the built page under `pult://app`
 * is the deferred part of xaxis `pult/shell-electron-wrapper`.
 */
import * as NodePath from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from "electron";

import { appDisplayName, appUserDataName } from "../../src/identity.ts";
import { Channel, VERSION_ARG, type Reply } from "./ipc.ts";
import { openSecretStore } from "./secretStore.ts";
import { windowState } from "./windowState.ts";

const isDevelopment = !app.isPackaged;
const DEFAULT_PAGE_URL = new URL("http://localhost:5190");
const pageUrl = new URL(process.env.PULT_DEV_SERVER_URL || DEFAULT_PAGE_URL);
// The checkout this bundle (`desktop/dist/main.cjs`) was built in.
const repoRoot = NodePath.resolve(__dirname, "../..");

// The identity goes first: userData decides where Chromium keeps the profile,
// and the name is the macOS menu's and the Keychain item's.
app.setName(appDisplayName(isDevelopment));
app.setPath("userData", NodePath.join(app.getPath("appData"), userDataName()));

const secrets = openSecretStore(NodePath.join(app.getPath("userData"), "secrets.json"));
const state = windowState(NodePath.join(app.getPath("userData"), "window.json"));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app.whenReady().then(() => {
  if (!isDevelopment) {
    dialog.showErrorBox(app.name, "This build has no page to show: Pult's desktop runs in development only so far.");
    return app.quit();
  }
  app.dock?.setIcon(NodePath.join(repoRoot, "assets/pult/dev/macos-1024.png"));
  Menu.setApplicationMenu(applicationMenu());
  handleSecrets();
  openWindow();
  // macOS keeps the app running with no window; the Dock icon opens one again.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

/**
 * `pult-dev`, or `pult-dev-<host>-<port>` for a page on another dev server
 * (`pult-dev-localhost-5193`), so a run beside another keeps its own Chromium
 * profile and secrets file rather than writing over the other's.
 */
function userDataName(): string {
  const name = appUserDataName(isDevelopment);
  if (pageUrl.origin === DEFAULT_PAGE_URL.origin) return name;
  const host = pageUrl.hostname.replace(/[^\w.]+/g, "-").replace(/^-|-$/g, "");
  const port = pageUrl.port || (pageUrl.protocol === "https:" ? "443" : "80");
  return `${name}-${host}-${port}`;
}

function openWindow(): void {
  const { maximized, ...bounds } = state.restore();
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: app.name,
    backgroundColor: "#1f1f1f",
    webPreferences: {
      preload: NodePath.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [VERSION_ARG + app.getVersion()],
    },
  });
  if (maximized) window.maximize();
  state.track(window);
  window.once("ready-to-show", () => window.show());

  // Links leave for the user's browser; nothing navigates the window off the page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    openOutside(url);
  });

  // The dev server may not be up yet: show the empty window and say so; View, Reload loads it once it is.
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED, a load replaced by another.
    if (!isMainFrame || code === -3) return;
    console.error(`[pult-desktop] ${url} did not load (${description}); is \`pnpm dev\` serving it? Reload with Cmd+R once it is.`);
    window.show();
  });
  // A failed load is reported above, so its rejected promise is not.
  window.loadURL(pageUrl.href).catch(() => undefined);
}

/**
 * Answers `window.pultDesktop.secrets` (`src/desktop/api.ts`), only for the
 * page itself: a top frame at the page's origin. A refusal or a failure is a
 * message for the page to show.
 */
function handleSecrets(): void {
  const handle = <T>(channel: string, answer: (...args: string[]) => T) =>
    ipcMain.handle(channel, (event, ...args: unknown[]): Reply<T> => {
      if (!fromPage(event)) return { ok: false, error: `Pult refused ${channel} from ${event.senderFrame?.origin ?? "a closed frame"}.` };
      if (!args.every((arg) => typeof arg === "string")) return { ok: false, error: `${channel} takes strings.` };
      try {
        return { ok: true, value: answer(...args) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  handle(Channel.secretsGet, (key) => secrets.get(key));
  handle(Channel.secretsSet, (key, value) => secrets.set(key, value));
  handle(Channel.secretsDelete, (key) => secrets.delete(key));
  handle(Channel.secretsKeys, () => secrets.keys());
}

function fromPage(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && frame.origin === pageUrl.origin;
}

function sameOrigin(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === pageUrl.origin;
}

function openOutside(url: string): void {
  if (URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol)) void shell.openExternal(url);
}

/** The stock menu: the app's, Edit, View (Reload and the DevTools in development), Window. */
function applicationMenu(): Menu {
  return Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(isDevelopment
          ? [{ role: "reload" as const }, { role: "forceReload" as const }, { role: "toggleDevTools" as const }, { type: "separator" as const }]
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
}
