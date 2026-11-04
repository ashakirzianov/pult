// Run with `node --test src/files/paths.test.ts`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commonParent,
  folderShows,
  locate,
  namesEnvironment,
  projectsUnder,
  relativeTo,
  toHostPath,
  toUriPath,
} from "./paths.ts";

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

  it("finds the closest directory above every project, never a project itself", () => {
    assert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/repos/axis"]),
      "/Users/anton/repos",
    );
    assert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/repos/pult/vendor"]),
      "/Users/anton/repos",
    );
    assert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/.t3/scratch"]),
      "/Users/anton",
    );
    assert.equal(commonParent(["/Users/anton/repos/pult"]), "/Users/anton/repos");
    assert.equal(commonParent(["/srv/a", "/tmp/b"]), "/");
    assert.equal(commonParent(["/c:/Users/anton/a", "/c:/b"]), "/c:/");
    assert.equal(commonParent(["/c:/a", "/d:/b"]), undefined);
    assert.equal(commonParent([]), undefined);
  });

  it("shows only the way to the projects under a folder above them", () => {
    const roots = [
      "/home/repos/pult",
      "/home/repos/pult/vendor",
      "/home/.t3/scratch",
      "/elsewhere",
    ];
    assert.deepEqual(projectsUnder("/home", roots), ["/home/repos/pult", "/home/.t3/scratch"]);
    assert.equal(folderShows("/home", roots, "/home/repos"), true);
    assert.equal(folderShows("/home", roots, "/home/repos/pult/src/a.ts"), true);
    assert.equal(folderShows("/home", roots, "/home/repos/other"), false);
    assert.equal(folderShows("/home", roots, "/home/Downloads"), false);
    // Not under the folder at all.
    assert.equal(folderShows("/home", roots, "/elsewhere"), false);
    // A project's folder, or a folder with no project under it, shows everything.
    assert.equal(folderShows("/home/repos/pult", roots, "/home/repos/pult/dist"), true);
    assert.equal(folderShows("/srv", roots, "/srv/logs"), true);
  });
});
