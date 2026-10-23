import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "vite";

/**
 * Serves a built checkout of `pult-extension` to the shell: the manifest and the
 * list of its files as the virtual module `virtual:pult-extension`, and the files
 * themselves, untouched, under `/pult-extension/`. The workbench registers each
 * file's URL against the built-in extension (`src/pultExtension.ts`), so the
 * extension host loads `dist/web/extension.js` and the thread tabs their bundle
 * from here. Dev server only: a production build will copy the directory instead.
 */
export function pultExtension(extensionDir: string): Plugin {
  const virtualId = "virtual:pult-extension";
  const resolvedId = "\0" + virtualId;
  const base = "/pult-extension/";
  return {
    name: "pult-extension",
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return undefined;
      const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
      const files = [...walk(extensionDir, ["dist", "media"]), "package.json"];
      return `export const manifest = ${JSON.stringify(manifest)};
export const files = ${JSON.stringify(files)};
export const base = ${JSON.stringify(base)};
export const extensionDir = ${JSON.stringify(extensionDir)};`;
    },
    configureServer(server) {
      server.middlewares.use(base, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\//, ""));
        const file = path.join(extensionDir, rel);
        if (!file.startsWith(extensionDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          next();
          return;
        }
        res.setHeader("Content-Type", mime(file));
        res.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

function walk(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(rel);
      else out.push(rel);
    }
  };
  for (const dir of dirs) if (fs.existsSync(path.join(root, dir))) visit(dir);
  return out;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".html": "text/html",
};

function mime(file: string): string {
  return MIME[path.extname(file)] ?? "application/octet-stream";
}
