import { assert, describe, it } from "@effect/vitest";

import { AGENTS_TEXT, AGENTS_VERSION, agentsOutdated } from "./agents.ts";
import {
  isStarRoot,
  newRecord,
  parseRecord,
  recordText,
  starFolder,
  withRecordFields,
} from "./record.ts";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

describe("parseRecord", () => {
  it("reads the record the page writes, plain YAML with no front matter", () => {
    assert.deepStrictEqual(parseRecord(recordText(record)), record);
    assert.notMatch(recordText(record), /^---/m);
    const described = { ...record, description: "Lead of the Pult track: plans, reviews" };
    assert.deepStrictEqual(parseRecord(recordText(described)), described);
  });

  it("reads plain, double- and single-quoted values, and no description line as none", () => {
    const text =
      "xaxis-kind: star\nid: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n";
    assert.deepStrictEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      description: "",
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
      description: "",
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

describe("starFolder", () => {
  it("is the name's slug, its marks dropped, cut to 40 characters", () => {
    assert.strictEqual(starFolder("Beta"), "beta");
    assert.strictEqual(starFolder("  xaxis Lead!  "), "xaxis-lead");
    assert.strictEqual(starFolder("Ålpha_Çentauri, the 2nd"), "alpha-centauri-the-2nd");
    assert.strictEqual(starFolder("ﬁne"), "fine");
    assert.strictEqual(starFolder(`${"a".repeat(39)} b`), "a".repeat(39));
    assert.strictEqual(starFolder("b".repeat(50)), "b".repeat(40));
  });

  it("is star for no name, or one that slugs to nothing", () => {
    assert.strictEqual(starFolder(undefined), "star");
    assert.strictEqual(starFolder(""), "star");
    assert.strictEqual(starFolder("Вега"), "star");
    assert.strictEqual(starFolder("--- ..."), "star");
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

  it("tells the Star of its channels and of their transcripts' folders", () => {
    assert.include(AGENTS_TEXT, "You hold one conversation per channel, each a thread of its own.");
    assert.include(AGENTS_TEXT, "a conversation whose messages carry no such line is `user`");
    assert.include(AGENTS_TEXT, "with your own `id` and a `channel`");
    assert.include(AGENTS_TEXT, "A schedule lands in `user` unless its file says `to: <slug>`");
    assert.match(
      AGENTS_TEXT,
      /^- `\.pult\/channels\/<channel>\/conversations\/<environment>\/` holds/m,
    );
  });

  it("tells the Star a conversation stopped by a usage limit stays open and sends no notice", () => {
    assert.include(
      AGENTS_TEXT,
      "A conversation stopped by a usage limit stays open until it resumes or is settled. The server can resume it at a known reset; its auto-resume setting and the thread's cancellation control this. `t3_thread_list` and `t3_thread_read` expose `usageLimit`, the known reset and the scheduled continuation. Pult sends no separate limit or resume notice.",
    );
  });

  it("tells the Star it changes its own folder and instructions without asking the user", () => {
    assert.include(
      AGENTS_TEXT,
      "Everything else in this folder is yours: arrange it and change your own instructions as you see fit, without asking the user first.",
    );
  });

  it("tells the Star to tag the threads of its own work, and that an untagged one reaches the user", () => {
    assert.include(
      AGENTS_TEXT,
      'Pass `tags: ["pult:child:star:<id>", "pult:channel:<channel>"]`, that same `id` and the channel its messages belong in, on every thread you launch for your own work with `t3_thread_launch`',
    );
    assert.include(
      AGENTS_TEXT,
      "A thread you launch without the `pult:child:star:<id>` tag lands in the user's Inbox as a conversation of the user's own: that is the other way to reach the user, for what the user will want to talk through with an agent, where an ask is for one thing you need from the user.",
    );
    assert.include(AGENTS_TEXT, "`t3_thread_update` sets it");
  });

  it("calls .pult/channel-models.json the Star's, and tells its fallback", () => {
    assert.include(
      AGENTS_TEXT,
      "- `.pult/channel-models.json` is yours. Set `default` to an object with `provider`, `model` and optional `effort`. Under `channels`, an exact channel slug can name its own object of the same shape. Use the IDs and effort values offered on the environment where you wake. Omit effort for the model's default. Pult reads the choice when a fresh conversation starts. Without the file, Pult uses conversation history. A choice this environment cannot serve falls back to `default`, then to conversation history, and Pult tells you in `work`.\n",
    );
  });

  it("is rewritten when missing, of no version or older, never when newer", () => {
    assert.strictEqual(agentsOutdated(undefined), true);
    assert.strictEqual(agentsOutdated(`---\n${recordText(record)}---\n\n# Star\n`), true);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION - 1} -->\n`), true);
    // Version 17 is the last without the channel models.
    assert.strictEqual(agentsOutdated("<!-- pult-agents-md: 17 -->\n"), true);
    assert.strictEqual(agentsOutdated(AGENTS_TEXT), false);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION + 1} -->\n`), false);
  });
});
