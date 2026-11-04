// The upstream modules the thread view replaces with files of ours, keyed by
// their path in the copy (`t3/`), valued by the replacement's path in this
// directory. The page's build resolves every import of a key to its value
// (`../vite.config.ts`); the copy keeps the upstream module, so the code that
// imports it still typechecks and `pnpm vendor:merge` still merges it, and the
// replacement states which upstream module it stands in for. A stub is how the
// thread view reaches what the app around it would provide; editing a copied
// file is the exception (`t3/EDITS.md`).
export const STUBS: Readonly<Record<string, string>> = {
  // The composition root of the vendored runtime, over the connection the page owns.
  "src/connection/runtime.ts": "shell/connectionRuntime.ts",
  // The device panel's 3D phone models, 12 MB of assets: the panel shows the
  // flat stream without them.
  "src/components/device/deviceModels.ts": "shell/stubs/deviceModels.ts",
  // No panel toggles at the pane's top right, which are the workbench's business in Pult.
  "src/components/chat/PanelLayoutControls.tsx": "shell/panelLayoutControls.tsx",
  // The provider registry without the provider packages, whose servers' SDKs
  // the page does not install.
  "src/components/settings/providerDriverMeta.ts": "shell/stubs/providerDriverMeta.ts",
  // Client settings with the context window meter always on: Pult has no
  // settings page to turn it on.
  "src/clientPersistenceStorage.ts": "shell/stubs/clientPersistenceStorage.ts",
};
