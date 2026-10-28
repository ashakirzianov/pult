import * as fs from "node:fs";
import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { STUBS } from "./thread-view/stubs.ts";
import { pultExtension } from "./vite/pultExtension.ts";

// The thread view (`thread-view/`): the tracked copy of the fork's apps/web in
// `t3/`, and the files of ours around it in `shell/`.
const threadView = path.join(import.meta.dirname, "thread-view");
const copy = path.join(threadView, "t3");

/** Resolves an import of a stubbed upstream module in the copy to its replacement (`thread-view/stubs.ts`). */
function threadViewStubs(): Plugin {
  const replacements = new Map(
    Object.entries(STUBS).map(([upstream, ours]) => [path.join(copy, upstream), path.join(threadView, ours)]),
  );
  return {
    name: "pult:thread-view-stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || replacements.has(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved === null ? undefined : replacements.get(resolved.id)) ?? null;
    },
  };
}

/**
 * The copy built as for a release in the page's development build too: upstream's development
 * build marks itself, its stage label "Dev" and that stage's artwork on the send button.
 */
function threadViewRelease(): Plugin {
  return {
    name: "pult:thread-view-release",
    enforce: "pre",
    transform: {
      filter: { code: { include: ["import.meta.env.DEV"] } },
      handler: (code, id) => (id.startsWith(copy + path.sep) ? code.replaceAll("import.meta.env.DEV", "false") : null),
    },
  };
}

/**
 * The fork's release at the pin, which its release stamps on `contracts` as on
 * its apps: the view reports it as its own, so upstream's version check
 * compares like with like.
 */
const appVersion: string = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "vendor/t3code/packages/contracts/package.json"), "utf8"),
).version;

// The fork's build-time configuration for its web app, all of it off: no T3 Connect, no hosted app.
const threadViewEnv = {
  VITE_WS_URL: "",
  VITE_HTTP_URL: "",
  VITE_T3CODE_RELAY_URL: "",
  VITE_CLERK_PUBLISHABLE_KEY: "",
  VITE_CLERK_JWT_TEMPLATE: "",
  VITE_CLERK_CLI_OAUTH_CLIENT_ID: "",
  VITE_RELAY_OTLP_TRACES_URL: "",
  VITE_RELAY_OTLP_TRACES_DATASET: "",
  VITE_RELAY_OTLP_TRACES_TOKEN: "",
  VITE_HOSTED_APP_URL: "",
  VITE_HOSTED_APP_CHANNEL: "",
  APP_VERSION: appVersion,
};

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
    // Upstream's too: the view's file viewers start module workers.
    worker: { format: "es" },
    // The view's file viewers load WebAssembly decoders as assets.
    assetsInclude: ["**/*.wasm"],
    plugins: [
      threadViewStubs(),
      threadViewRelease(),
      // The copy is built as the fork builds its web app, with the React Compiler; the shell's own React is not.
      react({ compiler: { sources: [threadView + path.sep] } }),
      tailwindcss(),
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
    define: Object.fromEntries(
      Object.entries(threadViewEnv).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
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
      // The copy's imports of its own `src/`.
      alias: [{ find: /^~\//, replacement: path.join(copy, "src") + "/" }],
      // One copy of each in the page: the workbench's singletons, and the client runtime the view and the shell share.
      dedupe: ["vscode", "react", "react-dom", "effect", "@t3tools/client-runtime", "@t3tools/contracts", "@t3tools/shared"],
    },
  };
});
