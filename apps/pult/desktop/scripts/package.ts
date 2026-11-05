/**
 * `pnpm desktop:package`: Pult.app, upstream's desktop artifact
 * (`scripts/build-desktop-artifact.ts`) built under Pult's brand
 * (`src/brand.ts`) with the shell's built page as its renderer. Builds the
 * page, then the artifact, a dmg (and its zip) for this Mac's arch into the
 * repository's `release/` unless other arguments are given; they pass through
 * to the artifact script (`--output-dir`, `--target dir`, `--signed`, …).
 *
 * Its own two flags:
 * - `--app-version <x.y.z>` sets the version of the app bundle alone (its
 *   `Info.plist`, `latest-mac.yml`, the artifact names; the artifact script's
 *   `--app-version`), Pult.app's own line; the server and the packages keep
 *   upstream's version, and no manifest is rewritten. Without it the bundle
 *   carries upstream's.
 * - `--feed` names the update feed, `UPDATE_FEED_REPOSITORY` in `src/brand.ts`.
 *   Without it no feed is named whatever the shell or CI exports: the artifact
 *   script never sees `GITHUB_REPOSITORY` or `T3CODE_DESKTOP_UPDATE_REPOSITORY`
 *   (`pult/decisions`, `update-feed`).
 *
 * Unsigned, the bundle is signed ad hoc (`ad-hoc-signing`). Last, it writes
 * `COMMIT` beside the artifacts: the commit they were built from, followed by
 * `dirty` when the working tree had uncommitted changes.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UPDATE_FEED_REPOSITORY } from "../src/brand.ts";

const root = NodePath.resolve(import.meta.dirname, "../../../..");
const {
  ELECTRON_RUN_AS_NODE: _electronRunAsNode,
  GITHUB_REPOSITORY: _githubRepository,
  T3CODE_DESKTOP_UPDATE_REPOSITORY: _updateRepository,
  ...env
} = process.env;
const { feed, appVersion, args } = parseArgs(process.argv.slice(2));

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
    ...(appVersion === undefined ? [] : ["--app-version", appVersion]),
  ],
  root,
  {
    T3CODE_DESKTOP_BRAND: "apps/pult/desktop/src/brand.ts",
    ...(feed ? { T3CODE_DESKTOP_UPDATE_REPOSITORY: UPDATE_FEED_REPOSITORY } : {}),
  },
);
writeCommitNote();

/** Takes `--feed` and `--app-version` out of the arguments; the rest pass through. */
function parseArgs(argv: string[]): { feed: boolean; appVersion?: string; args: string[] } {
  let feed = false;
  let appVersion: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--feed") feed = true;
    else if (arg === "--app-version") appVersion = argv[++index];
    else if (arg.startsWith("--app-version=")) appVersion = arg.slice("--app-version=".length);
    else rest.push(arg);
  }
  // No prerelease suffix: upstream's channels read one, and the updater skips prereleases.
  if (appVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(appVersion)) {
    console.error(`[pult-package] --app-version takes <major>.<minor>.<patch>, not ${appVersion}.`);
    process.exit(1);
  }
  return { feed, ...(appVersion === undefined ? {} : { appVersion }), args: rest };
}

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
