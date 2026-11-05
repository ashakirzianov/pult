// Run with `node --test src/stars/record.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  isStarRoot,
  newRecord,
  parseRecord,
  stockInstructions,
  withRecordFields,
} from "./record.ts";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

NodeTest.describe("parseRecord", () => {
  NodeTest.test("reads the record the stock instructions carry", () => {
    NodeAssert.deepEqual(parseRecord(stockInstructions(record)), record);
  });

  NodeTest.test("reads plain, double- and single-quoted values", () => {
    const text =
      "---\nxaxis-kind: star\nid: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n---\nBody\n";
    NodeAssert.deepEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      tint: "mint",
      created: "2026-11-03",
    });
  });

  NodeTest.test(
    "finds no record in a file of another kind, without an id, or without front matter",
    () => {
      NodeAssert.equal(parseRecord("---\nxaxis-kind: note\nid: abc\n---\n"), undefined);
      NodeAssert.equal(parseRecord("---\nxaxis-kind: star\n---\n"), undefined);
      NodeAssert.equal(parseRecord("# Agents\n\nxaxis-kind: star\nid: abc\n"), undefined);
      NodeAssert.equal(parseRecord("---\nxaxis-kind: star\nid: abc\n"), undefined);
    },
  );
});

NodeTest.describe("withRecordFields", () => {
  NodeTest.test("sets an origin, and an empty one reads as none", () => {
    const set = withRecordFields(stockInstructions(record), { origin: "git@host:me/star.git" });
    NodeAssert.equal(parseRecord(set)?.origin, "git@host:me/star.git");
    NodeAssert.equal(parseRecord(withRecordFields(set, { origin: "" }))?.origin, undefined);
  });

  NodeTest.test(
    "rewrites the fields in place and leaves every other line and the body as they were",
    () => {
      const text =
        '---\nxaxis-kind: star\nid: abc\nname: ""\n# kept\ntint: amber\ncreated: x\n---\n\nThe body: name: kept\n';
      const written = withRecordFields(text, { name: "Vega", tint: "sky" });
      NodeAssert.equal(
        written,
        '---\nxaxis-kind: star\nid: abc\nname: "Vega"\n# kept\ntint: "sky"\ncreated: x\n---\n\nThe body: name: kept\n',
      );
      NodeAssert.deepEqual(parseRecord(written), {
        id: "abc",
        name: "Vega",
        tint: "sky",
        created: "x",
      });
    },
  );

  NodeTest.test("adds a field the front matter lacks, and quotes what YAML would misread", () => {
    const written = withRecordFields("---\nxaxis-kind: star\nid: abc\n---\nBody", {
      name: "a: b # c",
    });
    NodeAssert.equal(written, '---\nxaxis-kind: star\nid: abc\nname: "a: b # c"\n---\nBody');
    NodeAssert.equal(parseRecord(written)?.name, "a: b # c");
  });

  NodeTest.test("keeps a file's line endings, and leaves a file without front matter alone", () => {
    NodeAssert.equal(
      withRecordFields("---\r\nid: abc\r\n---\r\nBody\r\n", { tint: "rose" }),
      '---\r\nid: abc\r\ntint: "rose"\r\n---\r\nBody\r\n',
    );
    NodeAssert.equal(withRecordFields("Body", { name: "Vega" }), "Body");
  });
});

NodeTest.describe("isStarRoot", () => {
  NodeTest.test("is a folder of a .pult/stars directory, and nothing deeper or shallower", () => {
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars/star"), true);
    NodeAssert.equal(isStarRoot("/home/anton/.pult/stars/vega/"), true);
    NodeAssert.equal(isStarRoot("C:\\Users\\anton\\.pult\\stars\\star"), true);
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars"), false);
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars/star/memory"), false);
    NodeAssert.equal(isStarRoot("/Users/anton/repos/stars/star"), false);
    NodeAssert.equal(isStarRoot(null), false);
  });
});
