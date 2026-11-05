/**
 * `pnpm desktop:package`: Pult.app, upstream's desktop artifact
 * (`scripts/build-desktop-artifact.ts`) built under Pult's brand
 * (`src/brand.ts`) with the shell's built page as its renderer. Builds the
 * page, then the artifact, a dmg (and its zip) for this Mac's arch into the
 * repository's `release/` unless other arguments are given; they pass through
 * to the artifact script (`--output-dir`, `--target dir`, `--signed`, …).
 * Unsigned, the bundle is signed ad hoc; it names an update feed only when
 * `T3CODE_DESKTOP_UPDATE_REPOSITORY` (or `GITHUB_REPOSITORY`) does. Last, it
 * writes `COMMIT` beside the artifacts: the commit they were built from,
 * followed by `dirty` when the working tree had uncommitted changes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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
writeCommitNote();

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

/** The artifact script's output directory: `--output-dir`, else its environment variable, else `release/`. */
function outputDir(): string {
  const index = args.findIndex((arg) => arg === "--output-dir" || arg.startsWith("--output-dir="));
  const flag = index === -1 ? undefined : args[index];
  const value =
    flag === undefined
      ? env.T3CODE_DESKTOP_OUTPUT_DIR
      : flag.includes("=")
        ? flag.slice("--output-dir=".length)
        : args[index + 1];
  return NodePath.resolve(root, value ?? "release");
}

function writeCommitNote(): void {
  const git = (...gitArgs: string[]) =>
    NodeChildProcess.execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();
  const commit = `${git("rev-parse", "HEAD")}${git("status", "--porcelain") === "" ? "" : " dirty"}`;
  const note = NodePath.join(outputDir(), "COMMIT");
  NodeFS.writeFileSync(note, `${commit}\n`);
  console.log(`[pult-package] ${note}: ${commit}`);
}
