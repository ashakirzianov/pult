// Run with `node --test desktop/scripts/commitNote.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { commitNote, type Exec } from "./commitNote.ts";

const roots: string[] = [];
NodeTest.after(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

function tree(...markers: string[]): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pult-commit-note-"));
  roots.push(root);
  for (const marker of markers) {
    const contents = marker === ".xaxis-checkout" ? "b35e21e2-f6dd-41b3-af91-eff48e93bb17\n" : "";
    NodeFS.writeFileSync(NodePath.join(root, marker), contents);
  }
  return root;
}

/** Answers each program from `answers`, by its command line, and records the lines asked. */
function exec(answers: Record<string, string>): Exec & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(
    (file: string, args: readonly string[]) => {
      const line = [file, ...args].join(" ");
      calls.push(line);
      const answer = answers[line];
      if (answer === undefined) throw new Error(`unexpected ${line}`);
      return answer;
    },
    { calls },
  );
}

const HEAD = "sha256:ba69205a5cf667a2becdd2c17aa66016361abe9f0afd0a77a5d18a51d566a2af";
const status = (changes: unknown[]) =>
  JSON.stringify({ format: 1, head: HEAD, changes, conflict: null, interrupted: null, stack: [] });

NodeTest.describe("commitNote", () => {
  NodeTest.it("names a git checkout's commit, dirty while it has changes", () => {
    const root = tree();
    const sha = "38c9ba4538aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const clean = exec({ "git rev-parse HEAD": `${sha}\n`, "git status --porcelain": "" });
    NodeAssert.equal(commitNote(root, clean), sha);
    NodeAssert.deepEqual(clean.calls, ["git rev-parse HEAD", "git status --porcelain"]);
    const dirty = exec({ "git rev-parse HEAD": `${sha}\n`, "git status --porcelain": " M x\n" });
    NodeAssert.equal(commitNote(root, dirty), `${sha} dirty`);
  });

  NodeTest.it("names an xaxis checkout's changeset, dirty while it has changes", () => {
    const root = tree(".xaxis-checkout");
    const clean = exec({ "xaxis status --json": status([]) });
    NodeAssert.equal(commitNote(root, clean), HEAD);
    NodeAssert.deepEqual(clean.calls, ["xaxis status --json"]);
    const dirty = exec({ "xaxis status --json": status([{ kind: "modified", path: "x" }]) });
    NodeAssert.equal(commitNote(root, dirty), `${HEAD} dirty`);
  });

  NodeTest.it("refuses a tree that is both, and a checkout it cannot read as settled", () => {
    NodeAssert.throws(() => commitNote(tree(".git", ".xaxis-checkout"), exec({})), /both/);
    const conflicted = JSON.stringify({ ...JSON.parse(status([])), conflict: { paths: ["x"] } });
    NodeAssert.throws(
      () => commitNote(tree(".xaxis-checkout"), exec({ "xaxis status --json": conflicted })),
      /not a settled checkout/,
    );
  });
});
