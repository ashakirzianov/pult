import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { citedPath } from "./citedPath.ts";

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
