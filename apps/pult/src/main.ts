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
import { registerChanges } from "./changes/view.ts";
import { startConnection } from "./connection/index.ts";
import { installDebugHandle } from "./debug.ts";
import { registerLocalServerCommands, startLocalServerContext } from "./desktop/localServer.ts";
import { startMenuActions } from "./desktop/menuActions.ts";
import { installDesktopTitleBar } from "./desktop/titleBar.ts";
import { registerMode, startMode } from "./mode.ts";
import { gateEditorMenus } from "./editorMenus.ts";
import { registerPultFiles } from "./files/index.ts";
import { registerLimits } from "./limits/index.ts";
import { startPanelRows } from "./panel/rows.tsx";
import { registerPanelSettings, startPanelSettings } from "./panel/settings.ts";
import { registerPanel } from "./panel/view.tsx";
import { registerColorSchemeCommand } from "./settings/colorScheme.ts";
import { registerSettingsPane } from "./settings/pane.tsx";
import { registerStarCommands } from "./stars/commands.ts";
import { startStarConversations } from "./stars/conversations.ts";
import { startStarSync } from "./stars/syncing.ts";
import { startStars } from "./stars/model.ts";
import { registerStarSettings, startStarSettings } from "./stars/settings.ts";
import { startThreadModel } from "./threads/model.ts";
import { registerThreadPane } from "./threads/pane.tsx";
import { registerParkCommands } from "./threads/park.ts";
import { registerSelectThreadCommand, restoreThreadSelection } from "./threads/selection.ts";
import { desktopSecrets, localStorageSecrets } from "./secrets.ts";
import { registerCiteCommand } from "./composer/cite.ts";
import { registerComposerCommands, startComposerStrip } from "./composer/index.tsx";
import { registerStatusCommands, startStatusBar } from "./status/index.tsx";
import { openVsxGallery, workbenchServices } from "./services.ts";
import { syncColorScheme } from "./theme.ts";
import { installWorkers } from "./workers.ts";

installWorkers();

// User data (settings, keybindings, storage) persists in IndexedDB across reloads.
await createIndexedDBProviders();

// An empty workspace file: the panel sets its `pult:` folders to the thread
// model's roots (`src/panel/explorer.ts`), "Pult: Open Project" adds to them,
// and VS Code keeps the editor layout per workspace.
const workspaceFile = Uri.file("/pult.code-workspace");
const memory = new RegisteredFileSystemProvider(false);
memory.registerFile(
  new RegisteredMemoryFile(workspaceFile, JSON.stringify({ folders: [] }, null, 2)),
);
registerFileSystemOverlay(1, memory);

startConnection();
// Before the workbench initialises, so the explorer restores its `pult:` folders on the page's provider.
registerPultFiles();
startThreadModel();
startStars();
startStarConversations();
startStarSync();
registerLimits();
registerThreadPane();
registerSettingsPane();
registerColorSchemeCommand();
registerMode();
registerPanelSettings();
registerStarSettings();
registerStarCommands();
gateEditorMenus();
registerStatusCommands();
registerComposerCommands();
registerCiteCommand();
registerSelectThreadCommand();
registerParkCommands();
registerChanges();
registerPanel();
registerLocalServerCommands();

// The workbench owns the whole page, the desktop's traffic lights over its top row; its parts are the layout (xaxis `pult/own-shell`).
if (window.pultDesktop) installDesktopTitleBar(window.pultDesktop);
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
  secretStorageProvider: window.pultDesktop
    ? desktopSecrets(window.pultDesktop)
    : localStorageSecrets,
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

// Read as soon as the configuration service is up, so a hidden Settled shelf never shows while the workbench starts.
const panelSettings = Promise.all([startPanelSettings(), startStarSettings()]);

await initialize(workbenchServices(), container, options, {
  userHome: Uri.file("/"),
});

await syncColorScheme();
await startMode();
await panelSettings;
await startStatusBar();
await startComposerStrip();
await startPanelRows();
await restoreThreadSelection();
await startLocalServerContext();
startMenuActions();

console.info("[pult-shell] workbench up");
installDebugHandle();
