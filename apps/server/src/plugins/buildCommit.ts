// @effect-diagnostics nodeBuiltinImport:off
// Runs at pack time, inside vite.config.ts, before any Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The commit a bundle is built from, baked into `serverBuild`; undefined outside a git checkout. */
export const buildCommit = (cwd: string): string | undefined => {
  // Pult: an xaxis checkout (its marker at the repository's root, two up from `apps/server`) has
  // no commit; git there would answer an enclosing repository's.
  if (NodeFS.existsSync(NodePath.join(cwd, "..", "..", ".xaxis-checkout"))) return undefined;
  try {
    return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
};
