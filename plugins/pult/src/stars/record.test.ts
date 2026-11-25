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

/** The changed passages of version 20, word for word as approved (`rename-user-and-work-channels.task/design.md`). */
const CHANNELS =
  "You hold one conversation per channel, each a thread of its own. They can run at the same time and share only this folder. A channel is a slug, lowercase letters, digits and hyphens starting with a letter or a digit, up to 51 characters, and naming one makes it: give a piece of work a channel of its own, and its reports gather where its history is. No channel is special by name. `default-channel` in your record names your default channel, `main` where the record has no such line: the one Pult opens for the user as your tab, and where a message or a schedule lands that names no channel, Pult's own among them. The first message of every conversation opens with a bracket line that names the channel you are in: `[To your channel <channel>]` over the user's own message, `[From <sender>, to your channel <channel>]` over a delivered one, `[In reply to your ask ..., to your channel <channel>]` over the user's reply to an ask. The user reads along only in a conversation they are writing in. Elsewhere nobody reads as you write: what a sender needs goes back to the sender, what the user needs is an ask, and what the next turn needs is in this folder before this turn ends, since Pult ends a conversation after any turn once its cache expired or its context reached the channel's `rotate-on-context`. `pult_star_message` with your own `id` and a `channel` hands something to another of your channels. Keep one file per concern, and read a file again before changing it: another channel may have changed it.";
const SETTINGS =
  "- `.pult/channels/<channel>/settings.yaml` is yours, one channel's settings, and `.pult/channels/settings.yaml` every channel's; a channel's file wins key by key. Each is plain `key: value` lines. `provider`, `model` and optional `effort` choose the model a fresh conversation of the channel starts with: use the IDs and effort values offered on the environment where you wake, and omit `effort` for the model's default. `rotate-on-context` says when Pult ends a conversation for its size: thousands of tokens written `250k`, the conversation ending after the turn that reaches them; or `never`. Where no file says, the model is your newest conversation's and `rotate-on-context` is `250k`. A choice this environment cannot serve falls back to every channel's file, then to conversation history, and Pult tells the channel that woke, once per content.";

const record = newRecord("5f0c7e1a-2b3c-4d5e-8f90-1a2b3c4d5e6f", "2026-11-03T12:00:00.000Z");

describe("parseRecord", () => {
  it("reads the record the page writes, plain YAML with no front matter", () => {
    assert.deepStrictEqual(parseRecord(recordText(record)), record);
    assert.notMatch(recordText(record), /^---/m);
    const described = { ...record, description: "Lead of the Pult track: plans, reviews" };
    assert.deepStrictEqual(parseRecord(recordText(described)), described);
  });

  it("reads plain, double- and single-quoted values, and no description line as none", () => {
    const text = "id: abc\nname: 'Vega''s'\ntint: \"mint\"\ncreated: 2026-11-03\n";
    assert.deepStrictEqual(parseRecord(text), {
      id: "abc",
      name: "Vega's",
      description: "",
      tint: "mint",
      created: "2026-11-03",
      defaultChannel: "main",
    });
  });

  it("reads default-channel as its slug, and main where it is absent or no slug", () => {
    const text = (line: string) => `id: abc\n${line}`;
    assert.strictEqual(parseRecord(text("default-channel: user\n"))?.defaultChannel, "user");
    assert.strictEqual(parseRecord(text('default-channel: "unit-2"\n'))?.defaultChannel, "unit-2");
    assert.strictEqual(parseRecord(text(""))?.misnamedDefaultChannel, undefined);
    for (const value of ["User", "", "-work"]) {
      const read = parseRecord(text(`default-channel: ${value}\n`));
      assert.strictEqual(read?.defaultChannel, "main", value);
      assert.strictEqual(read?.misnamedDefaultChannel, value, value);
    }
  });

  it("finds no record in a file without an id", () => {
    assert.strictEqual(parseRecord('name: "Vega"\n'), undefined);
    assert.strictEqual(parseRecord('id: ""\nname: "Vega"\n'), undefined);
  });

  it("reads a record that still carries the old kind line, and keeps the line through a rewrite", () => {
    const text = 'xaxis-kind: star\nid: abc\nname: ""\n';
    assert.strictEqual(parseRecord(text)?.id, "abc");
    const written = withRecordFields(text, { name: "Vega" });
    assert.strictEqual(written, 'xaxis-kind: star\nid: abc\nname: "Vega"\n');
    assert.strictEqual(parseRecord(written)?.name, "Vega");
  });
});

describe("withRecordFields", () => {
  it("rewrites the fields in place and leaves every other line as it was", () => {
    const text = 'id: abc\nname: ""\n# kept\ntint: amber\ncreated: x\n';
    const written = withRecordFields(text, { name: "Vega", tint: "sky" });
    assert.strictEqual(written, 'id: abc\nname: "Vega"\n# kept\ntint: "sky"\ncreated: x\n');
    assert.deepStrictEqual(parseRecord(written), {
      id: "abc",
      name: "Vega",
      description: "",
      tint: "sky",
      created: "x",
      defaultChannel: "main",
    });
  });

  it("adds a field the record lacks, and quotes what YAML would misread", () => {
    const written = withRecordFields("id: abc\n", { name: "a: b # c" });
    assert.strictEqual(written, 'id: abc\nname: "a: b # c"\n');
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

  it("points the Star at the three ask tools, whose reply and notice name its channel", () => {
    for (const tool of ["`pult_ask`", "`pult_ask_settle`", "`pult_ask_list`"])
      assert.include(AGENTS_TEXT, tool);
    assert.include(
      AGENTS_TEXT,
      '`[In reply to your ask <id> "<title>", to your channel <channel>]`',
    );
    assert.notInclude(AGENTS_TEXT, ".pult/asks");
  });

  it("tells the Star that an answer to a reply goes into the ask, asked again", () => {
    assert.include(
      AGENTS_TEXT,
      "So put the answer in the ask: change the ask's file so that it opens with your answer (or pass a new `text`, for an ask posted with `text`), then call `pult_ask` with its `id`, which returns it to their Inbox. Answering in the conversation as well is fine; alone it is not enough.",
    );
  });

  it("calls .pult/schedules/ the Star's, and names the runs' record", () => {
    assert.match(AGENTS_TEXT, /^- `\.pult\/schedules\/` is yours: /m);
    assert.include(AGENTS_TEXT, "record of the runs in `.pult/runs/`.");
  });

  it("tells the Star its channels, none special by name, and of their transcripts' folders", () => {
    assert.include(AGENTS_TEXT, `\n\n${CHANNELS}\n\n`);
    assert.include(
      AGENTS_TEXT,
      "`tint` is one of amber, coral, rose, violet, indigo, sky or mint. `default-channel` is the slug of your default channel. Leave `id` and `created` as they are.",
    );
    assert.include(AGENTS_TEXT, "those of a thread with no channel tag in your default channel");
    assert.include(
      AGENTS_TEXT,
      "A schedule lands in your default channel unless its file says `to: <slug>`",
    );
    assert.include(AGENTS_TEXT, "and Pult tells the schedule's channel when it starts failing.");
    assert.include(
      AGENTS_TEXT,
      "Do it when a unit of work is done and what must outlive it is written in this folder",
    );
    assert.include(
      AGENTS_TEXT,
      "Never do it in a conversation the user is talking with you in: it leaves their view.\n",
    );
    assert.notMatch(AGENTS_TEXT, /`user`|`work`/u);
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

  it("calls the channels' settings files the Star's, and tells their keys and fallback", () => {
    assert.include(AGENTS_TEXT, `\n${SETTINGS}\n\n`);
    assert.notInclude(AGENTS_TEXT, "channel-models");
  });

  it("is rewritten when missing, of no version or older, never when newer", () => {
    assert.strictEqual(agentsOutdated(undefined), true);
    assert.strictEqual(agentsOutdated(`---\n${recordText(record)}---\n\n# Star\n`), true);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION - 1} -->\n`), true);
    // Version 19 is the last with `user` and `work` special.
    assert.strictEqual(agentsOutdated("<!-- pult-agents-md: 19 -->\n"), true);
    // Version 22 is the last without where the answer to a reply goes.
    assert.strictEqual(agentsOutdated("<!-- pult-agents-md: 22 -->\n"), true);
    assert.strictEqual(agentsOutdated(AGENTS_TEXT), false);
    assert.strictEqual(agentsOutdated(`<!-- pult-agents-md: ${AGENTS_VERSION + 1} -->\n`), false);
  });
});
