// @effect-diagnostics nodeBuiltinImport:off - Build configuration resolves the brand module before an Effect runtime exists.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  type DesktopBrand,
  type DesktopBrandOverride,
  T3CODE_DESKTOP_BRAND,
} from "../../apps/desktop/src/app/DesktopBrand.ts";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

/**
 * The brand `T3CODE_DESKTOP_BRAND` names, the path of a module (relative to
 * the repository's root) whose default export is a `DesktopBrandOverride`;
 * `null` when it names none, which builds T3 Code.
 */
export async function loadDesktopBrandOverride(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DesktopBrandOverride | null> {
  const modulePath = env.T3CODE_DESKTOP_BRAND?.trim();
  if (!modulePath) return null;
  const loaded = (await import(
    NodeURL.pathToFileURL(NodePath.resolve(REPO_ROOT, modulePath)).href
  )) as { readonly default?: DesktopBrandOverride };
  if (typeof loaded.default !== "object" || loaded.default === null)
    throw new Error(`T3CODE_DESKTOP_BRAND: ${modulePath} has no default export.`);
  return loaded.default;
}

export async function loadDesktopBrand(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DesktopBrand> {
  return { ...T3CODE_DESKTOP_BRAND, ...(await loadDesktopBrandOverride(env)) };
}
