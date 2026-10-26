import type { IWorkbenchConstructionOptions } from "@codingame/monaco-vscode-api";

import type { PultDesktop } from "./desktop/api.ts";

type Provider = NonNullable<IWorkbenchConstructionOptions["secretStorageProvider"]>;

const PREFIX = "pult.secret:";

/**
 * VS Code's browser secret storage is in memory unless the embedder hands the
 * workbench a provider, so the page's bearer would be gone on every reload.
 * In a browser tab the page's localStorage holds the secrets; `src/main.ts`
 * picks `desktopSecrets` instead when the desktop wrapper's preload is present.
 */
export const localStorageSecrets: Provider = {
  type: "persisted",
  async get(key) {
    return localStorage.getItem(PREFIX + key) ?? undefined;
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
  },
  async keys() {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .map((key) => key.slice(PREFIX.length));
  },
};

/**
 * The desktop wrapper's secrets (`window.pultDesktop.secrets`), kept by its
 * main process encrypted with the OS keychain's key (pult/decisions,
 * `desktop-secrets`). A `set` it cannot encrypt rejects with a message for
 * the user, which the connect notice shows.
 */
export const desktopSecrets = (desktop: PultDesktop): Provider => ({
  type: "persisted",
  get: (key) => desktop.secrets.get(key),
  set: (key, value) => desktop.secrets.set(key, value),
  delete: (key) => desktop.secrets.delete(key),
  keys: () => desktop.secrets.keys(),
});
