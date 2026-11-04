// Run with `node --test src/files/paths.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

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

NodeTest.describe("pult: paths", () => {
  NodeTest.it("carries POSIX and Windows host paths", () => {
    NodeAssert.equal(toUriPath("/Users/anton/repos/pult/"), "/Users/anton/repos/pult");
    NodeAssert.equal(toHostPath(toUriPath("/Users/anton/x.ts")), "/Users/anton/x.ts");
    // VS Code lowercases a drive letter in every URI it saves.
    NodeAssert.equal(toUriPath("C:\\Users\\anton\\x.ts"), "/c:/Users/anton/x.ts");
    NodeAssert.equal(toHostPath("/c:/Users/anton/x.ts"), "c:/Users/anton/x.ts");
    NodeAssert.equal(toUriPath("C:\\"), "/c:/");
  });

  NodeTest.it("locates a path in the innermost root, never in a sibling sharing a prefix", () => {
    const roots = ["/repos/pult", "/repos/pult/vendor", "/repos/pult-extension"];
    NodeAssert.deepEqual(locate(roots, "/repos/pult/vendor/x.ts"), {
      root: "/repos/pult/vendor",
      relativePath: "x.ts",
    });
    NodeAssert.equal(locate(roots, "/repos/pult-extension/a.ts")?.root, "/repos/pult-extension");
    NodeAssert.deepEqual(locate(roots, "/repos/pult"), { root: "/repos/pult", relativePath: "" });
    NodeAssert.equal(locate(roots, "/repos/other/a.ts"), undefined);
    NodeAssert.equal(relativeTo("/", "/etc/hosts"), "etc/hosts");
  });

  NodeTest.it("matches an authority VS Code lowercased", () => {
    NodeAssert.equal(namesEnvironment("3f2a-ab", "3F2A-AB"), true);
    NodeAssert.equal(namesEnvironment("3f2a-ab", "3f2a-ac"), false);
  });

  NodeTest.it("finds the closest directory above every project, never a project itself", () => {
    NodeAssert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/repos/axis"]),
      "/Users/anton/repos",
    );
    NodeAssert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/repos/pult/vendor"]),
      "/Users/anton/repos",
    );
    NodeAssert.equal(
      commonParent(["/Users/anton/repos/pult", "/Users/anton/.t3/scratch"]),
      "/Users/anton",
    );
    NodeAssert.equal(commonParent(["/Users/anton/repos/pult"]), "/Users/anton/repos");
    NodeAssert.equal(commonParent(["/srv/a", "/tmp/b"]), "/");
    NodeAssert.equal(commonParent(["/c:/Users/anton/a", "/c:/b"]), "/c:/");
    NodeAssert.equal(commonParent(["/c:/a", "/d:/b"]), undefined);
    NodeAssert.equal(commonParent([]), undefined);
  });

  NodeTest.it("shows only the way to the projects under a folder above them", () => {
    const roots = [
      "/home/repos/pult",
      "/home/repos/pult/vendor",
      "/home/.t3/scratch",
      "/elsewhere",
    ];
    NodeAssert.deepEqual(projectsUnder("/home", roots), ["/home/repos/pult", "/home/.t3/scratch"]);
    NodeAssert.equal(folderShows("/home", roots, "/home/repos"), true);
    NodeAssert.equal(folderShows("/home", roots, "/home/repos/pult/src/a.ts"), true);
    NodeAssert.equal(folderShows("/home", roots, "/home/repos/other"), false);
    NodeAssert.equal(folderShows("/home", roots, "/home/Downloads"), false);
    // Not under the folder at all.
    NodeAssert.equal(folderShows("/home", roots, "/elsewhere"), false);
    // A project's folder, or a folder with no project under it, shows everything.
    NodeAssert.equal(folderShows("/home/repos/pult", roots, "/home/repos/pult/dist"), true);
    NodeAssert.equal(folderShows("/srv", roots, "/srv/logs"), true);
  });
});
