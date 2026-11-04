// Run with `node --test src/stars/record.test.ts`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isStarRoot,
  newRecord,
  parseRecord,
  stockInstructions,
  withRecordFields,
} from "./record.ts";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

describe("parseRecord", () => {
  test("reads the record the stock instructions carry", () => {
    assert.deepEqual(parseRecord(stockInstructions(record)), record);
  });

  test("reads plain, double- and single-quoted values", () => {
    const text =
      "---\nxaxis-kind: star\nid: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n---\nBody\n";
    assert.deepEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      tint: "mint",
      created: "2026-11-03",
    });
  });

  test("finds no record in a file of another kind, without an id, or without front matter", () => {
    assert.equal(parseRecord("---\nxaxis-kind: note\nid: abc\n---\n"), undefined);
    assert.equal(parseRecord("---\nxaxis-kind: star\n---\n"), undefined);
    assert.equal(parseRecord("# Agents\n\nxaxis-kind: star\nid: abc\n"), undefined);
    assert.equal(parseRecord("---\nxaxis-kind: star\nid: abc\n"), undefined);
  });
});

describe("withRecordFields", () => {
  test("rewrites the fields in place and leaves every other line and the body as they were", () => {
    const text =
      '---\nxaxis-kind: star\nid: abc\nname: ""\n# kept\ntint: amber\ncreated: x\n---\n\nThe body: name: kept\n';
    const written = withRecordFields(text, { name: "Vega", tint: "sky" });
    assert.equal(
      written,
      '---\nxaxis-kind: star\nid: abc\nname: "Vega"\n# kept\ntint: "sky"\ncreated: x\n---\n\nThe body: name: kept\n',
    );
    assert.deepEqual(parseRecord(written), { id: "abc", name: "Vega", tint: "sky", created: "x" });
  });

  test("adds a field the front matter lacks, and quotes what YAML would misread", () => {
    const written = withRecordFields("---\nxaxis-kind: star\nid: abc\n---\nBody", {
      name: "a: b # c",
    });
    assert.equal(written, '---\nxaxis-kind: star\nid: abc\nname: "a: b # c"\n---\nBody');
    assert.equal(parseRecord(written)?.name, "a: b # c");
  });

  test("keeps a file's line endings, and leaves a file without front matter alone", () => {
    assert.equal(
      withRecordFields("---\r\nid: abc\r\n---\r\nBody\r\n", { tint: "rose" }),
      '---\r\nid: abc\r\ntint: "rose"\r\n---\r\nBody\r\n',
    );
    assert.equal(withRecordFields("Body", { name: "Vega" }), "Body");
  });
});

describe("isStarRoot", () => {
  test("is a folder of a .pult/stars directory, and nothing deeper or shallower", () => {
    assert.equal(isStarRoot("/Users/anton/.pult/stars/star"), true);
    assert.equal(isStarRoot("/home/anton/.pult/stars/vega/"), true);
    assert.equal(isStarRoot("C:\\Users\\anton\\.pult\\stars\\star"), true);
    assert.equal(isStarRoot("/Users/anton/.pult/stars"), false);
    assert.equal(isStarRoot("/Users/anton/.pult/stars/star/memory"), false);
    assert.equal(isStarRoot("/Users/anton/repos/stars/star"), false);
    assert.equal(isStarRoot(null), false);
  });
});
