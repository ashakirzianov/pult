// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run as `node scripts/setup-worktree.ts` by the t3.json
 * "Setup Worktree" action, or by hand in a worktree made with `git worktree
 * add`. Plain Node keeps one command working in every shell T3 Code spawns
 * (zsh, bash, fish, PowerShell): it installs dependencies, links the main
 * checkout's gitignored env files into this worktree, then warms the web
 * dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);
// The main checkout. T3 Code names it; run by hand, git's common dir does.
const projectRoot =
  process.env.T3CODE_PROJECT_ROOT ||
  NodePath.dirname(
    NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktree, encoding: "utf8" },
    ).trim(),
  );

// `shell` resolves `vp` through PATH, including Windows command shims. The main
// checkout's installed `vp` comes last, for a shell with no `vp` of its own.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const install = NodeChildProcess.spawnSync("vp i", {
  cwd: worktree,
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    [pathKey]: [process.env[pathKey], NodePath.join(projectRoot, "node_modules", ".bin")]
      .filter(Boolean)
      .join(NodePath.delimiter),
  },
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "pult", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
