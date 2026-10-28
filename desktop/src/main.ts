/**
 * The desktop wrapper's main process: one window on the shell page, under the
 * dev identity of `src/identity.ts`, with the page's secrets and the window's
 * state kept in `userData`. Development only so far: the page is the Vite dev
 * server's (`pnpm dev`, http://localhost:5190), or the one `PULT_DEV_SERVER_URL`
 * names for a run beside another; serving the built page under `pult://app`
 * is the deferred part of xaxis `pult/shell-electron-wrapper`.
 */
import * as NodePath from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from "electron";

import { appDisplayName, appUserDataName } from "../../src/identity.ts";
import { Channel, TOP_ROW_HEIGHT, VERSION_ARG, type Reply } from "./ipc.ts";
import { openSecretStore } from "./secretStore.ts";
import { windowState } from "./windowState.ts";

const isDevelopment = !app.isPackaged;
const DEFAULT_PAGE_URL = new URL("http://localhost:5190");
const pageUrl = devServerUrl(process.env.PULT_DEV_SERVER_URL);
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
  handlePermissions();
  handleSecrets();
  handleWindowState();
  openWindow();
  // macOS keeps the app running with no window; the Dock icon opens one again.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

/**
 * The page's URL: the default dev server's, or `PULT_DEV_SERVER_URL` when it
 * is a loopback `http://` or any `https://` URL, since the page's secrets
 * travel over it. Anything else is an error box, and the app quits.
 */
function devServerUrl(value: string | undefined): URL {
  if (!value) return DEFAULT_PAGE_URL;
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol === "https:" || (url?.protocol === "http:" && isLoopback(url.hostname))) return url;
  const message = `PULT_DEV_SERVER_URL is ${JSON.stringify(value)}, which Pult does not load: it takes a loopback http:// URL, as http://localhost:5194, or an https:// one, since the page's secrets travel over it.`;
  console.error(`[pult-desktop] ${message}`);
  // Safe before `ready`; it blocks until dismissed.
  dialog.showErrorBox(appDisplayName(isDevelopment), message);
  process.exit(1);
}

// A function, not a const: `devServerUrl` runs at module load, above it.
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d+){3}$/.test(hostname);
}

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
    // The page's chrome runs to the window's top edge: on macOS no title bar, the traffic lights 12px in
    // and centred in the page's top row, at its start, which the page leaves them (`TRAFFIC_LIGHTS_WIDTH`).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: Math.round(TOP_ROW_HEIGHT / 2 - 6) } }
      : {}),
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
  // The page takes back the lights' room while they are hidden (`window.pultDesktop.titleBar`).
  window.on("enter-full-screen", () => window.webContents.send(Channel.windowFullScreen, true));
  window.on("leave-full-screen", () => window.webContents.send(Channel.windowFullScreen, false));

  // Links leave for the user's browser; nothing navigates the window off the page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    if (sameOrigin(event.url)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  // A same-origin navigation the server redirects elsewhere is held to the same rule.
  window.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame || sameOrigin(event.url)) return;
    event.preventDefault();
    openOutside(event.url);
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
 * What the page's own origin is granted, as the workbench uses it: copying to
 * the clipboard and fullscreen in any of its frames, and reading the clipboard
 * in its top frame only, for the editor's Paste command and context menu
 * (Cmd+V, the menu's paste, needs no permission).
 */
const PAGE_PERMISSIONS = new Map([
  ["clipboard-sanitized-write", "any frame"],
  ["fullscreen", "any frame"],
  ["clipboard-read", "top frame"],
]);

/**
 * Electron grants every permission by default (camera, microphone, location,
 * notifications, clipboard reads), cross-origin frames included; the default
 * session denies all but `PAGE_PERMISSIONS`, and those to the page's origin
 * only. A denied request is logged on main's stderr, to tell what to grant.
 */
function handlePermissions(): void {
  const granted = (permission: string, url: string, isMainFrame: boolean) => {
    const frames = PAGE_PERMISSIONS.get(permission);
    return frames !== undefined && sameOrigin(url) && (frames === "any frame" || isMainFrame);
  };
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, { requestingUrl, isMainFrame }) => {
    const grant = granted(permission, requestingUrl, isMainFrame);
    if (!grant) console.warn(`[pult-desktop] denied ${permission} to ${requestingUrl}${isMainFrame ? "" : " (a subframe)"}`);
    callback(grant);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, { isMainFrame }) =>
    granted(permission, requestingOrigin, isMainFrame),
  );
}

/** Answers `window.pultDesktop.secrets` (`src/desktop/api.ts`). */
function handleSecrets(): void {
  handle(Channel.secretsGet, (_event, key) => secrets.get(key));
  handle(Channel.secretsSet, (_event, key, value) => secrets.set(key, value));
  handle(Channel.secretsDelete, (_event, key) => secrets.delete(key));
  handle(Channel.secretsKeys, () => secrets.keys());
}

/** Answers `window.pultDesktop.titleBar.isFullScreen`, for the page's own window. */
function handleWindowState(): void {
  handle(Channel.windowIsFullScreen, (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
}

/**
 * One handler of `window.pultDesktop`'s calls, answering only the page
 * itself: a top frame at the page's origin, sending strings. A refusal or a
 * failure is a message for the page to show.
 */
function handle<T>(channel: string, answer: (event: IpcMainInvokeEvent, ...args: string[]) => T): void {
  ipcMain.handle(channel, (event, ...args: unknown[]): Reply<T> => {
    if (!fromPage(event)) return { ok: false, error: `Pult refused ${channel} from ${event.senderFrame?.origin ?? "a closed frame"}.` };
    if (!args.every((arg) => typeof arg === "string")) return { ok: false, error: `${channel} takes strings.` };
    try {
      return { ok: true, value: answer(event, ...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
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
