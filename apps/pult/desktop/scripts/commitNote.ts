/**
 * The line `pnpm desktop:package` writes to `COMMIT`: what the build was made
 * from, followed by ` dirty` when the tree held uncommitted changes. A git
 * checkout names its commit; a monore checkout (its `.monore-checkout` marker,
 * no `.git`) names the changeset it stands at, the `head` of
 * `monore status --json`, `sha256:…`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs a program in the tree's root and answers its stdout; throws when it fails. */
export type Exec = (file: string, args: readonly string[]) => string;

export function commitNote(root: string, exec: Exec): string {
  // The marker holds the checkout's id, as the server's `MonoreVcsDriver` reads it.
  const marker = NodePath.join(root, ".monore-checkout");
  const isMonore =
    NodeFS.existsSync(marker) && CHECKOUT_ID.test(NodeFS.readFileSync(marker, "utf8").trim());
  if (isMonore && NodeFS.existsSync(NodePath.join(root, ".git"))) {
    throw new Error(`${root} holds both .git and .monore-checkout; which one it is is unknown.`);
  }
  if (!isMonore) {
    const git = (...gitArgs: string[]) => exec("git", gitArgs).trim();
    return `${git("rev-parse", "HEAD")}${git("status", "--porcelain") === "" ? "" : " dirty"}`;
  }
  const status = JSON.parse(exec("monore", ["status", "--json"])) as {
    format?: unknown;
    head?: unknown;
    changes?: unknown;
    conflict?: unknown;
    interrupted?: unknown;
  };
  if (
    status.format !== 1 ||
    typeof status.head !== "string" ||
    !Array.isArray(status.changes) ||
    status.conflict != null ||
    status.interrupted != null
  ) {
    throw new Error(
      `monore status --json in ${root} is not a settled checkout of format 1: ${JSON.stringify(status)}`,
    );
  }
  return `${status.head}${status.changes.length === 0 ? "" : " dirty"}`;
}
