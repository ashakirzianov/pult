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
import { initUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override/common";
import {
  createIndexedDBProviders,
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import { Uri } from "monaco-editor";

import defaultConfiguration from "./configuration.json?raw";
import { registerPultExtension } from "./pultExtension.ts";
import { openVsxGallery, workbenchServices } from "./services.ts";
import { installWorkers } from "./workers.ts";

installWorkers();

// User data (settings, keybindings, storage) persists in IndexedDB across reloads.
await createIndexedDBProviders();
await initUserConfiguration(defaultConfiguration);

// An empty workspace file: the Pult extension adds `pult:` folders to it when
// a project is opened, and VS Code keeps the editor layout per workspace.
const workspaceFile = Uri.file("/pult.code-workspace");
const memory = new RegisteredFileSystemProvider(false);
memory.registerFile(new RegisteredMemoryFile(workspaceFile, JSON.stringify({ folders: [] }, null, 2)));
registerFileSystemOverlay(1, memory);

const pult = registerPultExtension();

const container = document.createElement("div");
container.id = "workbench";
document.body.replaceChildren(container);

const options: IWorkbenchConstructionOptions = {
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

await pult.whenReady();
console.info("[pult-shell] workbench up; Pult extension registered as", pult.id);
