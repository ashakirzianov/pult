// Run with `node --test src/files/resolve.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { Checkout } from "../changes/checkouts.ts";
import { endsWithKey, type ResolveInput, resolveThreadPath } from "./resolve.ts";

const checkout = (root: string, projectId: string, branch?: string): Checkout => ({
  environmentId: "env",
  root,
  projectId,
  projectName: projectId,
  worktree: branch === undefined ? null : { branch },
});

const pult = checkout("/repos/pult", "pult");
const pultFix = checkout("/wt/pult-fix", "pult", "fix");
const star = checkout("/repos/pult-star", "pult-star");
const axis = checkout("/repos/axis", "axis");
const checkouts = [pult, star, axis, pultFix];

/** An environment whose files are `files`, by `pult:` path; each checkout's index lists those under it. */
function environment(files: ReadonlyArray<string>, failing: ReadonlyArray<string> = []) {
  const searched: Array<string> = [];
  const input = (path: string, checkoutRoot: string | null = "/repos/pult"): ResolveInput => ({
    path,
    checkoutRoot,
    projectId: "pult",
    checkouts,
    exists: async (candidate) => files.includes(candidate),
    search: async ({ root }, key) => {
      searched.push(root);
      if (failing.includes(root)) throw new Error(`no index for ${root}`);
      return files
        .filter(
          (file) => file.startsWith(`${root}/`) && file.includes(key.split("/").at(-1) ?? key),
        )
        .map((file) => file.slice(root.length + 1));
    },
  });
  return { input, searched };
}

NodeTest.describe("resolveThreadPath", () => {
  NodeTest.test(
    "opens a literal path that is there without searching, else searches the thread's checkout first",
    async () => {
      const { input, searched } = environment(["/wt/pult-fix/src/a.ts", "/repos/pult/src/a.ts"]);
      NodeAssert.deepEqual(await resolveThreadPath(input("src/a.ts", "/wt/pult-fix")), {
        kind: "open",
        path: "/wt/pult-fix/src/a.ts",
      });
      NodeAssert.deepEqual(await resolveThreadPath(input("/repos/pult/src/a.ts", "/wt/pult-fix")), {
        kind: "open",
        path: "/repos/pult/src/a.ts",
      });
      NodeAssert.deepEqual(searched, []);
      NodeAssert.deepEqual(await resolveThreadPath(input("/repos/axis/x.md")), {
        kind: "missing",
        key: "x.md",
        error: undefined,
      });
      NodeAssert.deepEqual(searched, [
        "/repos/pult",
        "/repos/pult-star",
        "/repos/axis",
        "/wt/pult-fix",
      ]);
    },
  );

  NodeTest.test("refuses an absolute path under no checkout of the environment", async () => {
    const { input, searched } = environment(["/etc/hosts"]);
    NodeAssert.deepEqual(await resolveThreadPath(input("/etc/hosts")), { kind: "outside" });
    NodeAssert.deepEqual(await resolveThreadPath(input("/repos/pult-starboard/a.ts")), {
      kind: "outside",
    });
    NodeAssert.deepEqual(searched, []);
  });

  NodeTest.test(
    "the thread's checkout wins outright: one match opens, several pick among themselves",
    async () => {
      const files = [
        "/repos/pult/src/files/paths.ts",
        "/repos/pult-star/src/files/paths.ts",
        "/repos/pult/src/profiles/paths.ts",
      ];
      const { input, searched } = environment(files);
      NodeAssert.deepEqual(await resolveThreadPath(input("files/paths.ts")), {
        kind: "open",
        path: "/repos/pult/src/files/paths.ts",
      });
      NodeAssert.deepEqual(searched, ["/repos/pult"]);
      const picked = await resolveThreadPath(input("paths.ts"));
      NodeAssert.equal(picked.kind, "pick");
      NodeAssert.deepEqual(
        picked.kind === "pick" && picked.candidates.map((candidate) => candidate.path),
        ["/repos/pult/src/files/paths.ts", "/repos/pult/src/profiles/paths.ts"],
      );
    },
  );

  NodeTest.test(
    "with none in the thread's checkout, searches the environment's others, a bare basename too",
    async () => {
      const files = [
        "/repos/axis/README.md",
        "/repos/pult-star/README.md",
        "/wt/pult-fix/README.md",
        "/repos/axis/docs/plan.md",
      ];
      const { input } = environment(files);
      const picked = await resolveThreadPath(input("README.md"));
      NodeAssert.deepEqual(
        picked.kind === "pick" && picked.candidates.map((candidate) => candidate.path),
        ["/wt/pult-fix/README.md", "/repos/axis/README.md", "/repos/pult-star/README.md"],
      );
      NodeAssert.deepEqual(await resolveThreadPath(input("docs/plan.md")), {
        kind: "open",
        path: "/repos/axis/docs/plan.md",
      });
    },
  );

  NodeTest.test("keys an absolute path by its path in the checkout holding it", async () => {
    const { input } = environment(["/repos/axis/src/lib/a.ts"]);
    NodeAssert.deepEqual(await resolveThreadPath(input("/repos/pult-star/lib/a.ts")), {
      kind: "open",
      path: "/repos/axis/src/lib/a.ts",
    });
  });

  NodeTest.test(
    "leaves out a checkout whose search fails, and names the first error when all do",
    async () => {
      const { input } = environment(["/repos/axis/x.ts"], ["/repos/pult", "/repos/pult-star"]);
      NodeAssert.deepEqual(await resolveThreadPath(input("x.ts")), {
        kind: "open",
        path: "/repos/axis/x.ts",
      });
      const failing = environment(
        [],
        checkouts.map((each) => each.root),
      );
      NodeAssert.deepEqual(await resolveThreadPath(failing.input("x.ts")), {
        kind: "missing",
        key: "x.ts",
        error: "no index for /repos/pult",
      });
    },
  );

  NodeTest.test("with no checkout of its own, searches every checkout", async () => {
    const { input } = environment(["/repos/axis/y.ts"]);
    NodeAssert.deepEqual(await resolveThreadPath(input("./y.ts", null)), {
      kind: "open",
      path: "/repos/axis/y.ts",
    });
  });
});

NodeTest.describe("endsWithKey", () => {
  NodeTest.test("matches whole segments", () => {
    NodeAssert.equal(endsWithKey("src/files/paths.ts", "files/paths.ts"), true);
    NodeAssert.equal(endsWithKey("src/profiles/paths.ts", "files/paths.ts"), false);
    NodeAssert.equal(endsWithKey("paths.ts", "paths.ts"), true);
  });
});
