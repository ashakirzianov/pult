/**
 * `pnpm desktop:package`: Pult.app, upstream's desktop artifact
 * (`scripts/build-desktop-artifact.ts`) built under Pult's brand
 * (`src/brand.ts`) with the shell's built page as its renderer. Builds the
 * page, then the artifact, a dmg for this Mac's arch into `release/` unless
 * other arguments are given; they pass through to the artifact script
 * (`--output-dir`, `--target dir`, `--signed`, …). Unsigned, the bundle is
 * signed ad hoc; it names an update feed only when
 * `T3CODE_DESKTOP_UPDATE_REPOSITORY` (or `GITHUB_REPOSITORY`) does.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../../../..");
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
const args = process.argv.slice(2);

run(
  NodePath.join(root, "node_modules/.bin/vp"),
  ["run", "build"],
  NodePath.join(root, "apps/pult"),
);
run(
  "node",
  [
    "scripts/build-desktop-artifact.ts",
    ...(args.length > 0 ? args : ["--platform", "mac", "--target", "dmg", "--arch", process.arch]),
  ],
  root,
  { T3CODE_DESKTOP_BRAND: "apps/pult/desktop/src/brand.ts" },
);

function run(command: string, commandArgs: string[], cwd: string, extra = {}): void {
  const result = NodeChildProcess.spawnSync(command, commandArgs, {
    cwd,
    env: { ...env, ...extra },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`[pult-package] ${command} ${commandArgs.join(" ")} failed.`);
    process.exit(result.status ?? 1);
  }
}
