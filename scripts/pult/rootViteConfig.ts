// Pult's client, apps/pult, is a copy of upstream's apps/web. The root config
// names apps/web by path in two places, and these helpers carry both over to
// apps/pult, so that upstream's lines in vite.config.ts stay as they are.
import * as NodeURL from "node:url";

import type { Plugin } from "vite-plus";

const WEB_DIR = "apps/web/";
const PULT_DIR = "apps/pult/";
const pultRoot = NodeURL.fileURLToPath(new URL(`../../${PULT_DIR}`, import.meta.url));

interface FileOverride {
  readonly files: Array<string>;
  readonly excludeFiles?: Array<string>;
}

const toPult = (globs: Array<string>) =>
  globs.map((glob) => (glob.startsWith(WEB_DIR) ? PULT_DIR + glob.slice(WEB_DIR.length) : glob));

/**
 * Each lint override that names apps/web files, followed by its apps/pult copy.
 * The copy sits right after its original, so later overrides still win over
 * earlier ones in both apps.
 */
export function withPultClientOverrides<T extends FileOverride>(overrides: Array<T>): Array<T> {
  return overrides.flatMap((override) =>
    override.files.some((glob) => glob.startsWith(WEB_DIR))
      ? [
          override,
          {
            ...override,
            files: toPult(override.files),
            ...(override.excludeFiles ? { excludeFiles: toPult(override.excludeFiles) } : {}),
          },
        ]
      : [override],
  );
}

/**
 * The root config aliases `~` to apps/web/src for tests run from the root, and
 * an alias applies before any plugin. This takes the alias over: a module
 * under apps/pult gets `~` as apps/pult/src, every other module keeps the
 * alias's own target.
 */
export function pultClientTildeAlias(): Plugin {
  let webSrc: string | undefined;
  return {
    name: "pult:client-tilde-alias",
    enforce: "pre",
    config(config) {
      const alias = config.resolve?.alias;
      if (alias && !Array.isArray(alias) && typeof alias === "object" && "~" in alias) {
        const aliases = alias as Record<string, string>;
        webSrc = aliases["~"];
        delete aliases["~"];
      }
    },
    resolveId(source, importer, options) {
      if (!source.startsWith("~/") || webSrc === undefined) return null;
      const base = importer?.startsWith(pultRoot) ? `${pultRoot}src` : webSrc;
      return this.resolve(`${base}/${source.slice(2)}`, importer, { ...options, skipSelf: true });
    },
  };
}
