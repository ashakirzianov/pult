import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
import { base, files, manifest } from "virtual:pult-extension";

/**
 * Pult's extension as a built-in of the shell: the manifest from its checkout,
 * run by the web worker extension host, with every file of its `dist/` and
 * `media/` served by the dev server (`vite/pultExtension.ts`). Call before the
 * workbench starts, so the extension is part of the first scan and activates on
 * `onStartupFinished` like an installed one.
 */
export function registerPultExtension() {
  const origin = window.location.origin;
  const extension = registerExtension(manifest, ExtensionHostKind.LocalWebWorker, { system: true });
  for (const file of files) {
    extension.registerFileUrl(file, `${origin}${base}${file}`);
  }
  return extension;
}
