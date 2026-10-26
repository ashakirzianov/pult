import "./style.css";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-theme-seti-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-javascript-default-extension";
import "@codingame/monaco-vscode-json-default-extension";
import "@codingame/monaco-vscode-markdown-basics-default-extension";
import "@codingame/monaco-vscode-css-default-extension";
import "@codingame/monaco-vscode-html-default-extension";
import "@codingame/monaco-vscode-yaml-default-extension";
import "@codingame/monaco-vscode-shellscript-default-extension";
import "@codingame/monaco-vscode-diff-default-extension";
import "@codingame/monaco-vscode-search-result-default-extension";
import "@codingame/monaco-vscode-references-view-default-extension";
import "@codingame/monaco-vscode-configuration-editing-default-extension";

import { initialize, type IWorkbenchConstructionOptions } from "@codingame/monaco-vscode-api";
import {
  createIndexedDBProviders,
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { Uri } from "monaco-editor";

import defaultConfiguration from "./configuration.json?raw";
import { startConnection } from "./connection/index.ts";
import { installDebugHandle } from "./debug.ts";
import { registerPanel } from "./panel/view.tsx";
import { registerPultExtension } from "./pultExtension.ts";
import { registerThreadPane } from "./threads/pane.tsx";
import { registerSelectThreadCommand, restoreThreadSelection } from "./threads/selection.ts";
import { syncStatusBarWithEditors } from "./threads/statusBar.ts";
import { desktopSecrets, localStorageSecrets } from "./secrets.ts";
import { openVsxGallery, workbenchServices } from "./services.ts";
import { installWorkers } from "./workers.ts";

installWorkers();

// User data (settings, keybindings, storage) persists in IndexedDB across reloads.
await createIndexedDBProviders();

// An empty workspace file: the panel sets its `pult:` folders to the thread
// model's roots (`src/panel/explorer.ts`), "Pult: Open Project" adds to them,
// and VS Code keeps the editor layout per workspace.
const workspaceFile = Uri.file("/pult.code-workspace");
const memory = new RegisteredFileSystemProvider(false);
memory.registerFile(new RegisteredMemoryFile(workspaceFile, JSON.stringify({ folders: [] }, null, 2)));
registerFileSystemOverlay(1, memory);

startConnection();
registerThreadPane();
registerSelectThreadCommand();
registerPanel();
const pult = registerPultExtension();

// The workbench owns the whole page; its parts are the layout (xaxis `pult/own-shell`).
const container = document.createElement("div");
container.id = "workbench";
document.body.append(container);

// `?remoteAuthority=host:port[&connectionToken=…]` points the workbench at a
// VS Code server (remote extension host) of the same commit.
const params = new URL(window.location.href).searchParams;
const remoteAuthority = params.get("remoteAuthority") ?? undefined;
const connectionToken = params.get("connectionToken") ?? undefined;

const options: IWorkbenchConstructionOptions = {
  remoteAuthority,
  connectionToken,
  // In the desktop wrapper (`desktop/`) its preload's keychain-backed store; in a browser tab localStorage.
  secretStorageProvider: window.pultDesktop ? desktopSecrets(window.pultDesktop) : localStorageSecrets,
  // The shell's defaults, under the user's own settings: chrome off but the sidebar's tabs, editor stock.
  configurationDefaults: JSON.parse(defaultConfiguration) as Record<string, unknown>,
  productConfiguration: {
    nameShort: "Pult",
    nameLong: "Pult",
    applicationName: "pult",
    ...openVsxGallery,
  },
  workspaceProvider: {
    trusted: true,
    workspace: { workspaceUri: workspaceFile },
    async open() {
      window.open(window.location.href);
      return true;
    },
  },
  developmentOptions: { logLevel: 2 },
};

await initialize(workbenchServices(), container, options, {
  userHome: Uri.file("/"),
});

await syncStatusBarWithEditors();
await restoreThreadSelection();

await pult.whenReady();
console.info("[pult-shell] workbench up; Pult extension registered as", pult.id);
installDebugHandle();
