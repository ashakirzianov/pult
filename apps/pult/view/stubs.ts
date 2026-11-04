// The upstream modules the thread view replaces with files of ours, keyed by
// their path in `apps/web`, valued by the replacement's, both from `apps/pult`.
// The page's build resolves every import of a key to its value
// (`../vite.config.ts`); `apps/web` keeps the upstream module, so the code that
// imports it still typechecks, and the replacement states which upstream module
// it stands in for. A stub is how the thread view reaches what the app around it
// would provide; a hook point in `apps/web` is the exception, made when neither
// a stub nor a file of ours can do it.
export const STUBS: Readonly<Record<string, string>> = {
  // The composition root of the client runtime, over the connection the page owns.
  "../web/src/connection/runtime.ts": "view/connectionRuntime.ts",
  // The device panel's 3D phone models, 12 MB of assets: the panel shows the
  // flat stream without them.
  "../web/src/components/device/deviceModels.ts": "view/stubs/deviceModels.ts",
  // No panel toggles at the pane's top right, which are the workbench's business in Pult.
  "../web/src/components/chat/PanelLayoutControls.tsx": "view/panelLayoutControls.tsx",
  // The provider registry without the provider packages, which the page leaves out.
  "../web/src/components/settings/providerDriverMeta.ts": "view/stubs/providerDriverMeta.ts",
  // Client settings with the context window meter always on: Pult has no
  // settings page to turn it on.
  "../web/src/clientPersistenceStorage.ts": "view/stubs/clientPersistenceStorage.ts",
};
