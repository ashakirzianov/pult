// Run with `node --test src/files/paths.test.ts`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locate, namesEnvironment, relativeTo, toHostPath, toUriPath } from "./paths.ts";

describe("pult: paths", () => {
  it("carries POSIX and Windows host paths", () => {
    assert.equal(toUriPath("/Users/anton/repos/pult/"), "/Users/anton/repos/pult");
    assert.equal(toHostPath(toUriPath("/Users/anton/x.ts")), "/Users/anton/x.ts");
    // VS Code lowercases a drive letter in every URI it saves.
    assert.equal(toUriPath("C:\\Users\\anton\\x.ts"), "/c:/Users/anton/x.ts");
    assert.equal(toHostPath("/c:/Users/anton/x.ts"), "c:/Users/anton/x.ts");
    assert.equal(toUriPath("C:\\"), "/c:/");
  });

  it("locates a path in the innermost root, never in a sibling sharing a prefix", () => {
    const roots = ["/repos/pult", "/repos/pult/vendor", "/repos/pult-extension"];
    assert.deepEqual(locate(roots, "/repos/pult/vendor/x.ts"), {
      root: "/repos/pult/vendor",
      relativePath: "x.ts",
    });
    assert.equal(locate(roots, "/repos/pult-extension/a.ts")?.root, "/repos/pult-extension");
    assert.deepEqual(locate(roots, "/repos/pult"), { root: "/repos/pult", relativePath: "" });
    assert.equal(locate(roots, "/repos/other/a.ts"), undefined);
    assert.equal(relativeTo("/", "/etc/hosts"), "etc/hosts");
  });

  it("matches an authority VS Code lowercased", () => {
    assert.equal(namesEnvironment("3f2a-ab", "3F2A-AB"), true);
    assert.equal(namesEnvironment("3f2a-ab", "3f2a-ac"), false);
  });
});
