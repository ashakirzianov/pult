// Run with `node --test view/chipCandidate.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { chipCandidate } from "./chipCandidate.ts";

NodeTest.test("a bare name with an extension is a chip, its trimmed text", () => {
  for (const name of ["design.md", "some-task.task", "threads.send"])
    NodeAssert.equal(chipCandidate(name), name);
  NodeAssert.equal(chipCandidate(" design.md "), "design.md");
});

NodeTest.test(
  "a word without an extension, with whitespace, or refused by the view's link parser, is none",
  () => {
    for (const code of ["foo", "a b.md", "design.", "a`b.md", ".env", "x@y.md"])
      NodeAssert.equal(chipCandidate(code), null);
  },
);

NodeTest.test("a path-shaped span is upstream's rule's, refused where it refuses", () => {
  NodeAssert.equal(chipCandidate("src/files/paths.ts:12"), "src/files/paths.ts:12");
  NodeAssert.equal(chipCandidate("patches/"), null);
});
