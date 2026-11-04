import assert from "node:assert/strict";
import { test } from "node:test";

import { diffExcerpt } from "./diffExcerpt.ts";

// a b c d e → a B c d2 d3 e: line 2 replaced, line 4 replaced by two.
const original = ["a", "b", "c", "d", "e"];
const modified = ["a", "B", "c", "d2", "d3", "e"];
const mappings = [
  { original: { startLineNumber: 2, endLineNumberExclusive: 3 }, modified: { startLineNumber: 2, endLineNumberExclusive: 3 } },
  { original: { startLineNumber: 4, endLineNumberExclusive: 5 }, modified: { startLineNumber: 4, endLineNumberExclusive: 6 } },
];

test("a new line selected quotes it as an addition", () => {
  assert.deepEqual(diffExcerpt({ original, modified, mappings, side: "new", startLine: 2, endLine: 2 }), {
    startIndex: 2,
    endIndex: 2,
    rangeLabel: "+2",
    diff: "@@ -0,0 +2,1 @@\n+B",
  });
});

test("new lines across a change take the removed lines between them", () => {
  const excerpt = diffExcerpt({ original, modified, mappings, side: "new", startLine: 3, endLine: 5 });
  assert.equal(excerpt?.diff, "@@ -3,2 +3,3 @@\n c\n-d\n+d2\n+d3");
  assert.equal(excerpt?.rangeLabel, "3 to 5");
});

test("an old line selected quotes it as a removal", () => {
  const excerpt = diffExcerpt({ original, modified, mappings, side: "old", startLine: 4, endLine: 4 });
  assert.equal(excerpt?.diff, "@@ -4,1 +0,0 @@\n-d");
  assert.equal(excerpt?.rangeLabel, "-4");
});

test("unchanged lines are context on either side", () => {
  assert.equal(diffExcerpt({ original, modified, mappings, side: "old", startLine: 5, endLine: 5 })?.diff, "@@ -5,1 +6,1 @@\n e");
  assert.equal(diffExcerpt({ original, modified, mappings, side: "new", startLine: 1, endLine: 1 })?.rangeLabel, "1");
});

test("a selection past both files quotes nothing", () => {
  assert.equal(diffExcerpt({ original, modified, mappings, side: "new", startLine: 40, endLine: 41 }), null);
});
