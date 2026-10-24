import * as path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { pultExtension } from "./vite/pultExtension.ts";

export default defineConfig(({ mode }) => {
  // A built checkout of pult-extension (`pnpm i && pnpm build` in its `extension/`),
  // named by `PULT_EXTENSION_DIR` in the environment or the checkout's `.env`.
  const env = loadEnv(mode, import.meta.dirname, "");
  const extensionDir = path.resolve(
    process.env.PULT_EXTENSION_DIR ??
      env.PULT_EXTENSION_DIR ??
      path.join(import.meta.dirname, "../pult-extension/extension"),
  );
  return {
    build: { target: "esnext" },
    worker: { format: "es" },
    plugins: [
      // The thread view arrives built, its React compiled already.
      react({ exclude: [/\/node_modules\//, /\/dist\/shell\//] }),
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
    resolve: {
      // The thread view imports these rather than bundling them: one copy in the page.
      dedupe: ["vscode", "react", "react-dom", "effect", "@t3tools/client-runtime", "@t3tools/contracts", "@t3tools/shared"],
    },
  };
});
