// Run with `node --test src/stars/record.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  AGENTS_TEXT,
  AGENTS_VERSION,
  agentsOutdated,
  isStarRoot,
  newRecord,
  parseLegacyRecord,
  parseRecord,
  recordText,
  withRecordFields,
} from "./record.ts";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

NodeTest.describe("parseRecord", () => {
  NodeTest.test("reads the record the page writes, plain YAML with no front matter", () => {
    NodeAssert.deepEqual(parseRecord(recordText(record)), record);
    NodeAssert.doesNotMatch(recordText(record), /^---/m);
  });

  NodeTest.test("reads plain, double- and single-quoted values", () => {
    const text =
      "xaxis-kind: star\nid: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n";
    NodeAssert.deepEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      tint: "mint",
      created: "2026-11-03",
    });
  });

  NodeTest.test("finds no record in a file of another kind, or without an id", () => {
    NodeAssert.equal(parseRecord("xaxis-kind: note\nid: abc\n"), undefined);
    NodeAssert.equal(parseRecord("xaxis-kind: star\n"), undefined);
  });
});

NodeTest.describe("parseLegacyRecord", () => {
  NodeTest.test(
    "reads the front matter of a legacy AGENTS.md or .pult/star.md, an origin ignored",
    () => {
      const legacy = `---\nxaxis-kind: star\nid: abc\nname: "Sirius"\ntint: amber\ncreated: x\norigin: "git@host:me/star.git"\n---\n\n# Star\n`;
      NodeAssert.deepEqual(parseLegacyRecord(legacy), {
        id: "abc",
        name: "Sirius",
        tint: "amber",
        created: "x",
      });
    },
  );

  NodeTest.test("finds no record without front matter, or of another kind", () => {
    NodeAssert.equal(parseLegacyRecord("# Agents\n\nxaxis-kind: star\nid: abc\n"), undefined);
    NodeAssert.equal(parseLegacyRecord("---\nxaxis-kind: star\nid: abc\n"), undefined);
    NodeAssert.equal(parseLegacyRecord("---\nxaxis-kind: note\nid: abc\n---\n"), undefined);
  });
});

NodeTest.describe("withRecordFields", () => {
  NodeTest.test("rewrites the fields in place and leaves every other line as it was", () => {
    const text = 'xaxis-kind: star\nid: abc\nname: ""\n# kept\ntint: amber\ncreated: x\n';
    const written = withRecordFields(text, { name: "Vega", tint: "sky" });
    NodeAssert.equal(
      written,
      'xaxis-kind: star\nid: abc\nname: "Vega"\n# kept\ntint: "sky"\ncreated: x\n',
    );
    NodeAssert.deepEqual(parseRecord(written), {
      id: "abc",
      name: "Vega",
      tint: "sky",
      created: "x",
    });
  });

  NodeTest.test("adds a field the record lacks, and quotes what YAML would misread", () => {
    const written = withRecordFields("xaxis-kind: star\nid: abc\n", { name: "a: b # c" });
    NodeAssert.equal(written, 'xaxis-kind: star\nid: abc\nname: "a: b # c"\n');
    NodeAssert.equal(parseRecord(written)?.name, "a: b # c");
  });

  NodeTest.test("keeps a file's line endings", () => {
    NodeAssert.equal(
      withRecordFields("id: abc\r\n", { tint: "rose" }),
      'id: abc\r\ntint: "rose"\r\n',
    );
  });
});

NodeTest.describe("isStarRoot", () => {
  NodeTest.test("is a folder of a .pult/stars directory, and nothing deeper or shallower", () => {
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars/star"), true);
    NodeAssert.equal(isStarRoot("/home/anton/.pult/stars/vega/"), true);
    NodeAssert.equal(isStarRoot("C:\\Users\\anton\\.pult\\stars\\star"), true);
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars"), false);
    NodeAssert.equal(isStarRoot("/Users/anton/.pult/stars/star/.pult"), false);
    NodeAssert.equal(isStarRoot("/Users/anton/repos/stars/star"), false);
    NodeAssert.equal(isStarRoot(null), false);
  });
});

NodeTest.describe("AGENTS.md", () => {
  NodeTest.test("loads the record and the Star's own instructions, and holds no record", () => {
    NodeAssert.match(AGENTS_TEXT, /^@\.pult\/star\.yaml$/m);
    NodeAssert.match(AGENTS_TEXT, /^@instructions\.md$/m);
    NodeAssert.equal(parseLegacyRecord(AGENTS_TEXT), undefined);
  });

  NodeTest.test("is rewritten when missing, of no version or older, never when newer", () => {
    NodeAssert.equal(agentsOutdated(undefined), true);
    NodeAssert.equal(agentsOutdated(`---\n${recordText(record)}---\n\n# Star\n`), true);
    NodeAssert.equal(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION - 1} -->\n`), true);
    NodeAssert.equal(agentsOutdated(AGENTS_TEXT), false);
    NodeAssert.equal(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION + 1} -->\n`), false);
  });
});
