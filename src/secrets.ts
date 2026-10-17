import type { IWorkbenchConstructionOptions } from "@codingame/monaco-vscode-api";

type Provider = NonNullable<IWorkbenchConstructionOptions["secretStorageProvider"]>;

const PREFIX = "pult.secret:";

/**
 * VS Code's browser secret storage is in memory unless the embedder hands the
 * workbench a provider, so the extension's connection credential was gone on
 * every reload. For the spike the page's localStorage holds it; a desktop
 * wrapper would use the OS keychain through Electron's safeStorage instead.
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
