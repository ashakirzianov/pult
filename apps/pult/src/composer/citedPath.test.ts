import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { citedPath, diffFile } from "./citedPath.ts";

const selected = { environmentId: "env", root: "/repos/a" };

NodeTest.test("a file of the selected checkout is cited relative to it", () => {
  NodeAssert.equal(
    citedPath(selected, { environmentId: "ENV", hostPath: "/repos/a/src/x.ts" }),
    "src/x.ts",
  );
  NodeAssert.equal(
    citedPath(selected, { environmentId: "env", hostPath: "/repos/a/src/x.ts", root: "/repos/a" }),
    "src/x.ts",
  );
});

NodeTest.test("a file of another checkout is cited by its absolute path", () => {
  NodeAssert.equal(
    citedPath(selected, { environmentId: "env", hostPath: "/repos/b/src/x.ts", root: "/repos/b" }),
    "/repos/b/src/x.ts",
  );
  NodeAssert.equal(
    citedPath(selected, { environmentId: "env", hostPath: "/repos/b/x.ts" }),
    "/repos/b/x.ts",
  );
  // A worktree nested under the selected root is still another checkout.
  NodeAssert.equal(
    citedPath(selected, {
      environmentId: "env",
      hostPath: "/repos/a/.wt/x.ts",
      root: "/repos/a/.wt",
    }),
    "/repos/a/.wt/x.ts",
  );
});

NodeTest.test("a file of another environment, or with nothing selected, is cited absolute", () => {
  NodeAssert.equal(
    citedPath(selected, { environmentId: "other", hostPath: "/repos/a/x.ts" }),
    "/repos/a/x.ts",
  );
  NodeAssert.equal(
    citedPath(undefined, { environmentId: "env", hostPath: "/repos/a/x.ts" }),
    "/repos/a/x.ts",
  );
});

NodeTest.test("a diff's file is its change's or its Graph commit's, of its checkout", () => {
  const file = { environmentId: "env", cwd: "/repos/a", repositoryRoot: "/repos/a", path: "x.ts" };
  const change = { ...file, sourceKind: "working-tree" };
  const commit = { ...file, sha: "abc", parent: "def", previousPath: null };
  NodeAssert.deepEqual(diffFile(JSON.stringify({ change, side: "old" })), {
    environmentId: "env",
    root: "/repos/a",
    hostPath: "/repos/a/x.ts",
    source: "Uncommitted",
  });
  NodeAssert.equal(citedPath(selected, diffFile(JSON.stringify({ commit, side: "old" }))), "x.ts");
  // A project in a subdirectory of its repository: the path is the repository's.
  const nested = { ...commit, cwd: "/repos/a", repositoryRoot: "/repos", path: "a/x.ts" };
  NodeAssert.equal(
    citedPath(selected, diffFile(JSON.stringify({ commit: nested, side: "new" }))),
    "x.ts",
  );
  const other = { ...commit, cwd: "/repos/b", repositoryRoot: "/repos/b" };
  NodeAssert.equal(
    citedPath(selected, diffFile(JSON.stringify({ commit: other, side: "new" }))),
    "/repos/b/x.ts",
  );
});
