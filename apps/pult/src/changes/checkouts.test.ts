// Run with `node --test src/changes/checkouts.test.ts`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ReviewDiffPreviewSource } from "@t3tools/contracts";

import { checkoutName, checkoutsOf, shownChanges } from "./checkouts.ts";

const project = (environmentId: string, id: string, root: string | null) => ({ environmentId, id, name: id, root });
const thread = (environmentId: string, projectId: string, projectRoot: string | null, checkoutRoot: string | null, branch: string | null = null) => ({
  environmentId,
  projectId,
  projectName: projectId,
  projectRoot,
  checkoutRoot,
  branch,
});

describe("checkoutsOf", () => {
  test("lists each project's root and each worktree once, across environments", () => {
    const checkouts = checkoutsOf({
      projects: [project("a", "pult", "/repos/pult"), project("b", "pult", "/repos/pult"), project("a", "none", null)],
      threads: [
        thread("a", "pult", "/repos/pult", "/repos/pult"),
        thread("a", "pult", "/repos/pult", "/wt/pult-1/", "fix"),
        thread("a", "pult", "/repos/pult", "/wt/pult-1", "fix"),
        thread("a", "pult", "/repos/pult", "/wt/pult-2", null),
      ],
    });
    assert.deepEqual(
      checkouts.map((checkout) => [checkout.environmentId, checkout.root, checkoutName(checkout)]),
      [
        ["a", "/repos/pult", "pult"],
        ["b", "/repos/pult", "pult"],
        ["a", "/wt/pult-1", "pult · fix"],
        ["a", "/wt/pult-2", "pult · pult-2"],
      ],
    );
  });

  test("leaves a Star's folder out", () => {
    const star = "/Users/a/.pult/stars/star";
    const checkouts = checkoutsOf({ projects: [project("a", "star", star)], threads: [thread("a", "star", star, star)] });
    assert.deepEqual(checkouts, []);
  });

  test("takes a project's root from its thread when the environment lists none", () => {
    const checkouts = checkoutsOf({ projects: [], threads: [thread("a", "solo", "/repos/solo", "/repos/solo/")] });
    assert.deepEqual(
      checkouts.map((checkout) => [checkout.root, checkout.worktree]),
      [["/repos/solo", null]],
    );
  });
});

const source = (kind: ReviewDiffPreviewSource["kind"], paths: ReadonlyArray<string>, branch = "fix"): ReviewDiffPreviewSource => ({
  id: kind,
  kind,
  title: kind,
  baseRef: kind === "branch-range" ? "origin/main" : "HEAD",
  headRef: kind === "branch-range" ? branch : null,
  diff: "",
  diffHash: "hash",
  truncated: false,
  files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 0 })),
});

describe("shownChanges", () => {
  test("shows the working tree while it has uncommitted changes, though the branch repeats them", () => {
    const shown = shownChanges("a", "/repo", [source("branch-range", ["a.ts", "b.ts"]), source("working-tree", ["b.ts"])]);
    assert.equal(shown?.kind, "working-tree");
    assert.deepEqual(shown?.changes.map((change) => change.path), ["b.ts"]);
  });

  test("shows the branch's changes once everything is committed", () => {
    const shown = shownChanges("a", "/repo", [source("working-tree", []), source("branch-range", ["a.ts"])]);
    assert.equal(shown?.kind, "branch-range");
  });

  test("shows nothing once the base branch is committed, its unpushed commits being no branch's changes", () => {
    assert.equal(shownChanges("a", "/repo", [source("working-tree", []), source("branch-range", ["a.ts"], "main")]), undefined);
  });

  test("shows nothing without changes", () => {
    assert.equal(shownChanges("a", "/repo", [source("working-tree", []), source("branch-range", [])]), undefined);
    assert.equal(shownChanges("a", "/repo", []), undefined);
  });
});
