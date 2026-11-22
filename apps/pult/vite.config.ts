import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  Features,
  transform,
  type Declaration,
  type Selector,
  type SelectorComponent,
  type StyleRule,
} from "lightningcss";
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
 * The view's elements in the page, the scope of its stylesheet: the roots the
 * shell mounts it in, the thread's and the composer strip's
 * (`view/ThreadView.tsx`), a preview tab's (`view/PreviewMount.tsx`) and the
 * browser host's (`view/browserHost.tsx`), each `pult-view-theme` but the
 * first two, and what it puts on the page's
 * body: base-ui's portal node for every popover, menu, tooltip, dialog and
 * toast, and upstream's own portals there, the composer's command menu, the
 * cite-selection button and the context menu a page without the desktop's
 * native menus draws.
 */
const VIEW_ROOTS =
  ".pult-thread-view, .pult-view-theme, [data-base-ui-portal], [data-composer-drawer-layer], [data-assistant-selection-toolbar], [data-context-menu]";

/**
 * The shell's elements inside the view's, where its stylesheet stops: the
 * element a Star's details cards render into (`view/ThreadDetailsCard.tsx`).
 */
const SHELL_ISLANDS = ".pult-details-island";

/** One selector, parsed by Lightning CSS. */
function parseSelector(text: string): Selector {
  let selector: Selector | undefined;
  transform({
    filename: "selector.css",
    code: Buffer.from(`${text} {}`),
    visitor: { Rule: { style: (rule) => void (selector = rule.value.selectors[0]) } },
  });
  if (selector === undefined) throw new Error(`not a selector: ${text}`);
  return selector;
}

/**
 * A selector's subject compound, between its last combinator and its pseudo-elements.
 * Lightning CSS lists a selector's compounds from the first to the subject.
 */
function subjectOf(selector: Selector) {
  let start = selector.length;
  while (start > 0 && selector[start - 1]?.type !== "combinator") start--;
  let end = start;
  while (end < selector.length && selector[end]?.type !== "pseudo-element") end++;
  return {
    ancestors: selector.slice(0, start),
    own: selector.slice(start, end),
    elements: selector.slice(end),
  };
}

const isDocumentRoot = (component: SelectorComponent) =>
  (component.type === "type" && (component.name === "html" || component.name === "body")) ||
  (component.type === "pseudo-class" && (component.kind === "root" || component.kind === "host"));
const hasDocumentRootSubject = (selector: Selector) => subjectOf(selector).own.some(isDocumentRoot);
/**
 * Whether a selector's subject already names the scope, `:where(:scope, *)` or a
 * rule moved onto the thread view's root: a relative `:has()` hides a `:scope` of
 * its own deeper in, which marks nothing.
 */
const isMarked = (selector: Selector) =>
  subjectOf(selector).own.some(
    (component) =>
      component.type === "pseudo-class" &&
      component.kind === "where" &&
      component.selectors.some((inner) =>
        inner.some((part) => part.type === "pseudo-class" && part.kind === "scope"),
      ),
  );
const isToken = (declaration: Declaration) =>
  declaration.property === "custom" && declaration.value.name.startsWith("--");

/** Lightning CSS hands an absent optional out as null but reads some back only as a missing field (a `var()`'s `from`). */
function withoutNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutNulls) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, withoutNulls(field)]),
  ) as T;
}

function withDeclarations(rule: StyleRule, keep: (declaration: Declaration) => boolean) {
  const declarations = {
    declarations: (rule.declarations?.declarations ?? []).filter(keep),
    importantDeclarations: (rule.declarations?.importantDeclarations ?? []).filter(keep),
  };
  return declarations.declarations.length + declarations.importantDeclarations.length === 0
    ? undefined
    : { ...rule, declarations };
}

/** The rules that are global by name or by kind, which stay on the page outside the scope. */
const GLOBAL_RULES = [
  "keyframes",
  "font-face",
  "property",
  "layer-statement",
  "import",
  "namespace",
  "counter-style",
  "font-palette-values",
  "font-feature-values",
  "page",
  "custom-media",
] as const;
const unplaced = (rule: { type: string }) => {
  throw new Error(`the view's stylesheet has a ${rule.type} rule its scope does not place`);
};

/**
 * Upstream's stylesheet bounded to the view's elements (`VIEW_ROOTS`), so its
 * reset and its rules on the document leave the workbench's browser defaults
 * alone (a hover's bulleted list, the page's `color-scheme`); the view's
 * classes share no name with the workbench's. Its nesting flattened, it
 * leaves as two parts: on the page, its global rules and its custom
 * properties on `:root`, `html`, `body` and `:host`, which style nothing by
 * themselves and stay where upstream's own code writes over them (the `.dark`
 * class and `data-theme-id` on `<html>`, the appearance settings' inline
 * tokens); and every other rule inside one `@scope` over the view's elements,
 * a selector's subject marked `:where(:scope, *)` so a root that carries
 * classes of its own matches too, and the rest of a rule on the document's
 * root or body moved onto the thread view's root, its conditions on the root
 * kept as an ancestor test (`:root:is(.dark, .dark *) :where(:scope.pult-thread-view)`).
 * The scope stops at the shell's own elements inside the view's (`SHELL_ISLANDS`).
 */
function scopeThreadViewStylesheet(code: string, filename: string): string {
  const flat = transform({
    filename,
    code: Buffer.from(code),
    include: Features.Nesting,
    errorRecovery: false,
  }).code;
  const inScope = parseSelector(":where(:scope, *)");
  const atThreadRoot = parseSelector(":where(:scope.pult-thread-view)");
  const page = transform({
    filename,
    code: flat,
    errorRecovery: false,
    visitor: {
      Rule: {
        style(rule) {
          const selectors = rule.value.selectors.filter(hasDocumentRootSubject);
          const tokens = withDeclarations({ ...rule.value, selectors }, isToken);
          return selectors.length === 0 || tokens === undefined
            ? []
            : withoutNulls({ ...rule, value: tokens });
        },
      },
    },
  }).code;
  const scoped = transform({
    filename,
    code: flat,
    errorRecovery: false,
    visitor: {
      Rule: {
        ...Object.fromEntries(GLOBAL_RULES.map((type) => [type, () => []])),
        unknown: unplaced,
        custom: unplaced,
        nesting: unplaced,
        "nested-declarations": unplaced,
        viewport: unplaced,
        "moz-document": unplaced,
        "view-transition": unplaced,
        "position-try": unplaced,
        style(rule) {
          if (rule.value.rules?.length) unplaced({ type: "nested style" });
          const onRoots = rule.value.selectors.filter(hasDocumentRootSubject);
          if (onRoots.length === 0) return undefined;
          const others = rule.value.selectors.filter(
            (selector) => !hasDocumentRootSubject(selector),
          );
          const moved = withDeclarations(
            {
              ...rule.value,
              selectors: onRoots.map((selector) => {
                const { ancestors, own, elements } = subjectOf(selector);
                return [
                  ...ancestors,
                  ...own,
                  { type: "combinator", value: "descendant" },
                  ...atThreadRoot,
                  ...elements,
                ];
              }),
            },
            (declaration) => !isToken(declaration),
          );
          return withoutNulls([
            ...(others.length > 0
              ? [{ ...rule, value: { ...rule.value, selectors: others } }]
              : []),
            ...(moved === undefined ? [] : [{ ...rule, value: moved }]),
          ]);
        },
      },
      Selector(selector) {
        if (hasDocumentRootSubject(selector) || isMarked(selector)) return selector;
        const { ancestors, own, elements } = subjectOf(selector);
        return [...ancestors, ...own, ...inScope, ...elements];
      },
    },
  }).code;
  return `${page.toString()}\n@scope (${VIEW_ROOTS}) to (${SHELL_ISLANDS}) {\n${scoped.toString()}}\n`;
}

/** The view's stylesheet (`view/tailwind.css`), once Tailwind has built it, bounded to the view (`scopeThreadViewStylesheet`). */
function threadViewStylesheetScope(): Plugin {
  const stylesheet = NodePath.join(view, "tailwind.css");
  return {
    name: "pult:thread-view-stylesheet-scope",
    transform: (code, id) =>
      id.split("?")[0] === stylesheet
        ? { code: scopeThreadViewStylesheet(code, stylesheet), map: null }
        : null,
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
  build: {
    target: "esnext",
    // Pult.app's scheme allows no `data:` in `connect-src` or `worker-src`, so an asset inlined as one
    // (every workbench grammar, theme or manifest under 4 KB) fails the workbench's fetch and leaves
    // the editor plain.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // A workbench webview's host page registers its service worker at the worker's own
        // directory; alone in `assets/webview/`, it controls the webviews and nothing else,
        // not the extension host's iframe and the workers beside them in `assets/`.
        assetFileNames: (asset) =>
          asset.originalFileNames.some((name) => name.includes("/webview/browser/pre/"))
            ? "assets/webview/[name]-[hash][extname]"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
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
    threadViewStylesheetScope(),
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
