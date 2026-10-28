/**
 * Worktree setup, run as `node scripts/setup-worktree.ts` by the t3.json
 * "Setup Worktree" action, or by hand in a worktree made with `git worktree
 * add`. Plain Node keeps one command working in every shell T3 Code spawns:
 * it installs dependencies, then links the main checkout's gitignored `.env`
 * (where `PULT_T3CODE_CHECKOUT` lives, `scripts/checkout.ts`) into this worktree.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

const install = NodeChildProcess.spawnSync("pnpm i", { cwd: worktree, shell: true, stdio: "inherit" });
if (install.status !== 0) process.exit(install.status ?? 1);

// `.env` is a real file in the main checkout; a worktree gets a symlink to it.
// Only a symlink is ever replaced, so a real env file is never deleted.
const source = NodePath.join(projectRoot, ".env");
const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
if (sourceStat?.isFile()) {
  const target = NodePath.join(worktree, ".env");
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (!existing || existing.isSymbolicLink()) {
    if (existing) NodeFS.rmSync(target);
    NodeFS.symlinkSync(source, target);
  }
}
