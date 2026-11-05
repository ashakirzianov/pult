import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { STUBS } from "./view/stubs.ts";

// The thread view: upstream's web app, `apps/web`, built in place, and the files
// of ours around it in `view/`.
const view = NodePath.join(import.meta.dirname, "view");
const webSource = NodePath.join(import.meta.dirname, "../web/src");

/** Resolves an import of a stubbed upstream module in `apps/web` to its replacement (`view/stubs.ts`). */
function threadViewStubs(): Plugin {
  const replacements = new Map(
    Object.entries(STUBS).map(([upstream, ours]) => [
      NodePath.join(import.meta.dirname, upstream),
      NodePath.join(import.meta.dirname, ours),
    ]),
  );
  const ours = new Set(replacements.values());
  return {
    name: "pult:thread-view-stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || ours.has(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved === null ? undefined : replacements.get(resolved.id)) ?? null;
    },
  };
}

/**
 * `apps/web` built as for a release in the page's development build too: upstream's development
 * build marks itself, its stage label "Dev" and that stage's artwork on the send button.
 */
function threadViewRelease(): Plugin {
  return {
    name: "pult:thread-view-release",
    enforce: "pre",
    transform: {
      filter: { code: { include: ["import.meta.env.DEV"] } },
      handler: (code, id) =>
        id.startsWith(webSource + NodePath.sep)
          ? code.replaceAll("import.meta.env.DEV", "false")
          : null,
    },
  };
}

/**
 * The repository's release, which its release stamps on `contracts` as on its
 * apps: the view reports it as its own, so upstream's version check compares
 * like with like.
 */
const appVersion: string = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../../packages/contracts/package.json"),
    "utf8",
  ),
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

export default defineConfig({
  build: { target: "esnext" },
  // Upstream's too: the view's file viewers start module workers.
  worker: { format: "es" },
  // The view's file viewers load WebAssembly decoders as assets.
  assetsInclude: ["**/*.wasm"],
  plugins: [
    threadViewStubs(),
    threadViewRelease(),
    // The view is built as the fork builds its web app, with the React Compiler; the shell's own React is not.
    react({ compiler: { sources: [webSource + NodePath.sep, view + NodePath.sep] } }),
    tailwindcss(),
    {
      // The vendored workbench imports its CSS as strings and injects it itself.
      name: "load-vscode-css-as-string",
      enforce: "pre",
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (resolved == null) return undefined;
        if (
          /node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/.test(resolved.id)
        ) {
          return { ...resolved, id: resolved.id + "?inline" };
        }
        return undefined;
      },
    },
  ],
  define: Object.fromEntries(
    Object.entries(threadViewEnv).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  ),
  optimizeDeps: {
    include: [
      "@codingame/monaco-vscode-api/extensions",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-api/monaco",
    ],
  },
  // Another port is `vp dev --port <port>`; a server's allowed origins name the page's.
  server: {
    port: 5190,
    strictPort: true,
  },
  resolve: {
    // `apps/web`'s imports of its own `src/`.
    alias: [{ find: /^~\//, replacement: webSource + "/" }],
    // One copy of each in the page: the workbench's singletons, and the client runtime and router the view and the shell share.
    dedupe: [
      "vscode",
      "react",
      "react-dom",
      "effect",
      "@tanstack/react-router",
      "@t3tools/client-runtime",
      "@t3tools/contracts",
      "@t3tools/shared",
    ],
  },
});
