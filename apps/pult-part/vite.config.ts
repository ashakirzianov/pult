import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// One self-contained `dist/main.mjs`: the server runs it from a payload build
// directory, where there is no node_modules.
export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/main.ts"],
      outDir: "dist",
      platform: "node",
      clean: true,
      deps: { alwaysBundle: () => true, onlyBundle: false },
    },
  }),
);
