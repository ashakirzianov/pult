/**
 * Pult's identity: every name by which the operating system, the user and
 * other apps tell this app apart from an installed T3 Code. Sites read these
 * instead of spelling a literal, so a Pult app runs beside T3 Code without
 * either disturbing the other; `scripts/noUpstreamIdentity.test.ts` keeps it
 * so. Env var names, flags, package names and protocol headers stay upstream's
 * (DECISIONS.md, `identity-seam`).
 *
 * Plain constants only: `apps/desktop/scripts/electron-launcher.mjs` imports
 * this file under Node's type stripping.
 */

export const APP_BASE_NAME = "Pult";

/** The packaged app's name; `apps/desktop/package.json` `productName` matches it. */
export const APP_DISPLAY_NAME = APP_BASE_NAME;
export const APP_DEV_DISPLAY_NAME = `${APP_BASE_NAME} (Dev)`;

export const APP_BUNDLE_ID = "com.pult.pult";
export const APP_DEV_BUNDLE_ID = `${APP_BUNDLE_ID}.dev`;

/** URL schemes: the packaged renderer's origin and the OS URL handler. */
export const APP_SCHEME = "pult";
export const APP_DEV_SCHEME = "pult-dev";
export const APP_SCHEMES = [APP_SCHEME, APP_DEV_SCHEME] as const;

/** Electron's userData directory names under the OS app-data directory. */
export const APP_USER_DATA_NAME = "pult";
export const APP_DEV_USER_DATA_NAME = "pult-dev";

/** Linux window class and executable name. */
export const APP_LINUX_WM_CLASS = "pult";
export const APP_DEV_LINUX_WM_CLASS = "pult-dev";
export const APP_LINUX_DESKTOP_ENTRY_NAME = `${APP_BUNDLE_ID}.desktop`;
export const APP_DEV_LINUX_DESKTOP_ENTRY_NAME = `${APP_DEV_BUNDLE_ID}.desktop`;

/** The command name the CLI answers to and suggests. */
export const CLI_NAME = "pult";

/** The background service: systemd unit `<name>.service`, launchd label. */
export const BOOT_SERVICE_NAME = "pult";
// The `.service` suffix keeps the label distinct from the app's bundle id, so
// launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = `${APP_BUNDLE_ID}.service`;

export const DESKTOP_OBSERVABILITY_SERVICE_NAME = "pult-desktop";

/** Where the desktop backend starts scanning for a free port. */
export const DEFAULT_DESKTOP_BACKEND_PORT = 3883;

export const appDisplayName = (isDevelopment: boolean) =>
  isDevelopment ? APP_DEV_DISPLAY_NAME : APP_DISPLAY_NAME;
export const appBundleId = (isDevelopment: boolean) =>
  isDevelopment ? APP_DEV_BUNDLE_ID : APP_BUNDLE_ID;
export const appScheme = (isDevelopment: boolean) => (isDevelopment ? APP_DEV_SCHEME : APP_SCHEME);
export const appUserDataName = (isDevelopment: boolean) =>
  isDevelopment ? APP_DEV_USER_DATA_NAME : APP_USER_DATA_NAME;
export const appLinuxWmClass = (isDevelopment: boolean) =>
  isDevelopment ? APP_DEV_LINUX_WM_CLASS : APP_LINUX_WM_CLASS;
export const appLinuxDesktopEntryName = (isDevelopment: boolean) =>
  isDevelopment ? APP_DEV_LINUX_DESKTOP_ENTRY_NAME : APP_LINUX_DESKTOP_ENTRY_NAME;
