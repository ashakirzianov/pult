import * as path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pultExtension } from "./vite/pultExtension.ts";

// A built checkout of pult-extension (`pnpm i && pnpm build` in its `extension/`).
const extensionDir = path.resolve(
  process.env.PULT_EXTENSION_DIR ?? path.join(import.meta.dirname, "../pult-extension/extension"),
);

export default defineConfig({
  build: { target: "esnext" },
  worker: { format: "es" },
  plugins: [
    react(),
    pultExtension(extensionDir),
    {
      // The vendored workbench imports its CSS as strings and injects it itself.
      name: "load-vscode-css-as-string",
      enforce: "pre",
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (resolved == null) return undefined;
        if (/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)) {
          return { ...resolved, id: resolved.id + "?inline" };
        }
        return undefined;
      },
    },
  ],
  optimizeDeps: {
    include: [
      "@codingame/monaco-vscode-api/extensions",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-api/monaco",
    ],
  },
  server: {
    port: 5190,
    strictPort: true,
    fs: { allow: [".", extensionDir] },
  },
  resolve: { dedupe: ["vscode", "react", "react-dom"] },
});
