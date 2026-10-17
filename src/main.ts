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
import { Parts, setPartVisibility } from "@codingame/monaco-vscode-workbench-service-override/common";
import {
  createIndexedDBProviders,
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { Uri } from "monaco-editor";

import defaultConfiguration from "./configuration.json?raw";
import { installDebugHandle } from "./debug.ts";
import { registerPultExtension } from "./pultExtension.ts";
import { registerThreadPane } from "./threads/pane.tsx";
import { localStorageSecrets } from "./secrets.ts";
import { mountShell } from "./shell/mount.tsx";
import { openVsxGallery, workbenchServices } from "./services.ts";
import { installWorkers } from "./workers.ts";

installWorkers();

// User data (settings, keybindings, storage) persists in IndexedDB across reloads.
await createIndexedDBProviders();

// An empty workspace file: the Pult extension adds `pult:` folders to it when
// a project is opened, and VS Code keeps the editor layout per workspace.
const workspaceFile = Uri.file("/pult.code-workspace");
const memory = new RegisteredFileSystemProvider(false);
memory.registerFile(new RegisteredMemoryFile(workspaceFile, JSON.stringify({ folders: [] }, null, 2)));
registerFileSystemOverlay(1, memory);

registerThreadPane();
const pult = registerPultExtension();

const container = mountShell();

// Question 5: `?remoteAuthority=host:port[&connectionToken=…]` points the
// workbench at a VS Code server (remote extension host) of the same commit.
const params = new URL(window.location.href).searchParams;
const remoteAuthority = params.get("remoteAuthority") ?? undefined;
const connectionToken = params.get("connectionToken") ?? undefined;

const options: IWorkbenchConstructionOptions = {
  remoteAuthority,
  connectionToken,
  secretStorageProvider: localStorageSecrets,
  // The shell's defaults, under the user's own settings: chrome off, editor stock.
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

// The explorer and search live in a drawer (Cmd+B); the rail is the shell's.
setPartVisibility(Parts.SIDEBAR_PART, false);
await pult.whenReady();
console.info("[pult-shell] workbench up; Pult extension registered as", pult.id);
installDebugHandle();
