import { assert, describe, it } from "@effect/vitest";

import { AGENTS_TEXT, AGENTS_VERSION, agentsOutdated } from "./agents.ts";
import { isStarRoot, newRecord, parseRecord, recordText, withRecordFields } from "./record.ts";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

describe("parseRecord", () => {
  it("reads the record the page writes, plain YAML with no front matter", () => {
    assert.deepStrictEqual(parseRecord(recordText(record)), record);
    assert.notMatch(recordText(record), /^---/m);
  });

  it("reads plain, double- and single-quoted values", () => {
    const text =
      "xaxis-kind: star\nid: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n";
    assert.deepStrictEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      tint: "mint",
      created: "2026-11-03",
    });
  });

  it("finds no record in a file of another kind, or without an id", () => {
    assert.strictEqual(parseRecord("xaxis-kind: note\nid: abc\n"), undefined);
    assert.strictEqual(parseRecord("xaxis-kind: star\n"), undefined);
  });
});

describe("withRecordFields", () => {
  it("rewrites the fields in place and leaves every other line as it was", () => {
    const text = 'xaxis-kind: star\nid: abc\nname: ""\n# kept\ntint: amber\ncreated: x\n';
    const written = withRecordFields(text, { name: "Vega", tint: "sky" });
    assert.strictEqual(
      written,
      'xaxis-kind: star\nid: abc\nname: "Vega"\n# kept\ntint: "sky"\ncreated: x\n',
    );
    assert.deepStrictEqual(parseRecord(written), {
      id: "abc",
      name: "Vega",
      tint: "sky",
      created: "x",
    });
  });

  it("adds a field the record lacks, and quotes what YAML would misread", () => {
    const written = withRecordFields("xaxis-kind: star\nid: abc\n", { name: "a: b # c" });
    assert.strictEqual(written, 'xaxis-kind: star\nid: abc\nname: "a: b # c"\n');
    assert.strictEqual(parseRecord(written)?.name, "a: b # c");
  });

  it("keeps a file's line endings", () => {
    assert.strictEqual(
      withRecordFields("id: abc\r\n", { tint: "rose" }),
      'id: abc\r\ntint: "rose"\r\n',
    );
  });
});

describe("isStarRoot", () => {
  it("is a folder of a .pult/stars directory, and nothing deeper or shallower", () => {
    assert.strictEqual(isStarRoot("/Users/anton/.pult/stars/star"), true);
    assert.strictEqual(isStarRoot("/home/anton/.pult/stars/vega/"), true);
    assert.strictEqual(isStarRoot("C:\\Users\\anton\\.pult\\stars\\star"), true);
    assert.strictEqual(isStarRoot("/Users/anton/.pult/stars"), false);
    assert.strictEqual(isStarRoot("/Users/anton/.pult/stars/star/.pult"), false);
    assert.strictEqual(isStarRoot("/Users/anton/repos/stars/star"), false);
  });
});

describe("AGENTS.md", () => {
  it("loads the record and the Star's own instructions, and holds no record", () => {
    assert.match(AGENTS_TEXT, /^@\.pult\/star\.yaml$/m);
    assert.match(AGENTS_TEXT, /^@instructions\.md$/m);
    assert.strictEqual(parseRecord(AGENTS_TEXT), undefined);
  });

  it("calls .pult/asks/ the Star's, apart from the rest of .pult/", () => {
    assert.match(AGENTS_TEXT, /^- `\.pult\/asks\/` is yours: /m);
    assert.include(AGENTS_TEXT, "`.pult/`, apart from what is called yours above,");
  });

  it("calls .pult/schedules/ the Star's, and names the runs' record", () => {
    assert.match(AGENTS_TEXT, /^- `\.pult\/schedules\/` is yours: /m);
    assert.include(AGENTS_TEXT, "record of the runs in `.pult/runs/`.");
  });

  it("tells the Star of its two conversations and of their transcripts' folders", () => {
    assert.include(AGENTS_TEXT, "your conversation with the user, and your work conversation");
    assert.include(
      AGENTS_TEXT,
      "holds the transcripts of your earlier conversations in that channel",
    );
  });

  it("tells the Star to tag every thread it launches with its id", () => {
    assert.include(
      AGENTS_TEXT,
      'Pass `tags: ["pult:child:star:<id>"]`, that same `id`, on every thread you launch with `t3_thread_launch`',
    );
  });

  it("is rewritten when missing, of no version or older, never when newer", () => {
    assert.strictEqual(agentsOutdated(undefined), true);
    assert.strictEqual(agentsOutdated(`---\n${recordText(record)}---\n\n# Star\n`), true);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION - 1} -->\n`), true);
    assert.strictEqual(agentsOutdated(AGENTS_TEXT), false);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION + 1} -->\n`), false);
  });
});
