// Run with `node --test src/spelling/words.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { spellingWords } from "./words.ts";

const whole = (line: string) => spellingWords(line, [[0, line.length]]).map(({ word }) => word);

NodeTest.test("a sentence's words of four letters or more, edge punctuation trimmed", () => {
  NodeAssert.deepEqual(whole("(See the recieve flow, it's fine.)"), [
    "recieve",
    "flow",
    "it's",
    "fine",
  ]);
});

NodeTest.test("camelCase and hyphens split, acronyms and short words left alone", () => {
  NodeAssert.deepEqual(whole("fileStatusStore HTMLElement well-formd API ok"), [
    "file",
    "Status",
    "Store",
    "Element",
    "well",
    "formd",
  ]);
});

NodeTest.test("paths, URLs, identifiers and inline code are skipped whole", () => {
  NodeAssert.deepEqual(
    whole("see src/main.ts at https://exmple.com, snake_case, v2ray, `misspeled code` here"),
    ["here"],
  );
});

NodeTest.test("only the checkable ranges are read, offsets from the line's start", () => {
  const line = "const wrod = 1; // a wrod here";
  NodeAssert.deepEqual(spellingWords(line, [[16, line.length]]), [
    { word: "wrod", start: 21, end: 25 },
    { word: "here", start: 26, end: 30 },
  ]);
});
