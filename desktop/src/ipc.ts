/** The preload's IPC channels, one per call of `window.pultDesktop` that main answers. */
export const Channel = {
  secretsGet: "pult-desktop:secrets.get",
  secretsSet: "pult-desktop:secrets.set",
  secretsDelete: "pult-desktop:secrets.delete",
  secretsKeys: "pult-desktop:secrets.keys",
  windowIsFullScreen: "pult-desktop:window.isFullScreen",
  /** Main to the page, on every change: the window entered (`true`) or left full screen. */
  windowFullScreen: "pult-desktop:window.fullScreen",
} as const;

/**
 * On macOS the window draws no title bar: its traffic lights sit over the
 * page's top-left, centred in the page's top row (`TOP_ROW_HEIGHT`, the left
 * panel's header and the editor's tabs row), and the page leaves them this
 * many pixels at the row's start (`titleBar.lightsWidth` in
 * `src/desktop/api.ts`). Zero elsewhere, where the frame is the OS's.
 */
export const TRAFFIC_LIGHTS_WIDTH = process.platform === "darwin" ? 76 : 0;
export const TOP_ROW_HEIGHT = 35;

/**
 * What a handler answers. A failure travels as a message rather than a thrown
 * error, which Electron would wrap in "Error invoking remote method …", so the
 * preload rejects with the message main wrote for the user.
 */
export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** How main hands the preload the app's version: an `additionalArguments` entry, read from the renderer's argv. */
export const VERSION_ARG = "--pult-version=";
