// @effect-diagnostics nodeBuiltinImport:off - drives git in a temporary repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { transfer } from "./bench-merge.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function write(dir: string, file: string, bytes: string | Buffer, mode = 0o644) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, file), bytes);
  NodeFS.chmodSync(NodePath.join(dir, file), mode);
}

function commit(repo: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
  return git(repo, "rev-parse", "HEAD^{tree}");
}

it("transfers a merge's bytes, executable bits and deletions, and nothing else", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bench-merge-"));
  const repo = NodePath.join(root, "repo");
  const checkout = NodePath.join(root, "checkout");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q");
  for (const dir of [repo, checkout]) {
    write(dir, "kept.txt", "kept\n");
    write(dir, "changed.txt", "before\n");
    write(dir, "run.sh", "#!/bin/sh\n");
    write(dir, "gone/deep/file.txt", "gone\n");
  }
  const from = commit(repo);
  write(repo, "changed.txt", "after\r\n");
  NodeFS.chmodSync(NodePath.join(repo, "run.sh"), 0o755);
  NodeFS.rmSync(NodePath.join(repo, "gone"), { recursive: true });
  write(repo, "new/blob.bin", Buffer.from([0, 255, 10, 13]));
  const to = commit(repo);
  write(checkout, ".monore-checkout", "marker");
  write(checkout, "node_modules/x.js", "ignored");

  expect(transfer(repo, from, to, checkout)).toBe(4);

  expect(NodeFS.readFileSync(NodePath.join(checkout, "changed.txt"), "utf8")).toBe("after\r\n");
  expect(NodeFS.statSync(NodePath.join(checkout, "run.sh")).mode & 0o777).toBe(0o755);
  expect(NodeFS.readFileSync(NodePath.join(checkout, "new/blob.bin"))).toEqual(
    Buffer.from([0, 255, 10, 13]),
  );
  expect(NodeFS.existsSync(NodePath.join(checkout, "gone"))).toBe(false);
  expect(NodeFS.readFileSync(NodePath.join(checkout, ".monore-checkout"), "utf8")).toBe("marker");
  expect(NodeFS.existsSync(NodePath.join(checkout, "node_modules/x.js"))).toBe(true);

  NodeFS.symlinkSync("kept.txt", NodePath.join(repo, "link"));
  expect(() => transfer(repo, to, commit(repo), checkout)).toThrow(/link has git mode 120000/);
  NodeFS.rmSync(root, { recursive: true, force: true });
});
