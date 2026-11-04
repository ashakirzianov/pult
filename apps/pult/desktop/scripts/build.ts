/**
 * Bundles main and the preload into `dist/main.cjs` and `dist/preload.cjs`,
 * each self-contained but for `electron`: a sandboxed preload cannot resolve
 * packages, and main imports `src/identity.ts` from the page's sources.
 * `pnpm build` here; `scripts/dev.ts` runs it before each launch.
 */
import * as NodePath from "node:path";

import * as esbuild from "esbuild";

const desktopDir = NodePath.dirname(import.meta.dirname);

export async function build(): Promise<void> {
  await esbuild.build({
    absWorkingDir: desktopDir,
    entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: "linked",
    logLevel: "warning",
  });
}

if (import.meta.main) await build();
