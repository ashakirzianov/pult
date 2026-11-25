// Run with `node --test src/stars/plugin.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  actOnAsk,
  channelSettingsStars,
  channelTranscriptStars,
  createStarOn,
  defaultTranscriptStars,
  decodeAbout,
  decodeChannelTranscripts,
  decodeStars,
  decodeTranscript,
  writeStarRecord,
  PluginAnswerError,
  readAbout,
  readAsks,
  readStars,
  readStarTranscript,
  readStarTranscriptOfThread,
  parseRotateOnContext,
  readStarChannelSettings,
  readWakeModel,
  rotateOnContextText,
  sleepChannelOn,
  writeStarChannelSettings,
} from "./plugin.ts";

NodeTest.describe("the Stars directory's watch", () => {
  const batch = (paths: ReadonlyArray<string>, truncated = false) => ({
    changes: paths.map((path) => ({ path, kind: "created" as const })),
    truncated,
  });
  const answer = {
    directory: "/Users/a/.pult/stars/",
    stars: [
      { id: "one", root: "/Users/a/.pult/stars/star", defaultChannel: "user" },
      { id: "two", root: "/Users/a/.pult/stars/star-2", defaultChannel: "main" },
    ],
  };
  const transcript = (folder: string, slug: string) =>
    `${folder}/.pult/channels/${slug}/conversations/env/2026-11-12T10-00-00Z-t.md`;

  NodeTest.test("defaultTranscriptStars names the Star whose default channel changed", () => {
    NodeAssert.deepEqual(defaultTranscriptStars(batch([transcript("star", "user")]), answer), [
      "one",
    ]);
    NodeAssert.deepEqual(
      defaultTranscriptStars(batch([transcript("star-2", "main").replaceAll("/", "\\")]), answer),
      ["two"],
    );
    // Another Star's default channel's name is an ordinary channel here.
    NodeAssert.deepEqual(defaultTranscriptStars(batch([transcript("star", "main")]), answer), []);
    NodeAssert.deepEqual(
      defaultTranscriptStars(batch([transcript("star", "user-research")]), answer),
      [],
    );
    // The channel's folder itself, made or removed whole.
    NodeAssert.deepEqual(defaultTranscriptStars(batch(["star/.pult/channels/user"]), answer), [
      "one",
    ]);
    NodeAssert.deepEqual(
      defaultTranscriptStars(batch(["star/old.pult/channels/user/x.md", "star/notes.md"]), answer),
      [],
    );
    NodeAssert.deepEqual(defaultTranscriptStars(batch([], true), answer), ["one", "two"]);
  });

  NodeTest.test(
    "channelTranscriptStars names the Star whose channel but its default one had a transcript written",
    () => {
      NodeAssert.deepEqual(channelTranscriptStars(batch([transcript("star-2", "work")]), answer), [
        "two",
      ]);
      NodeAssert.deepEqual(
        channelTranscriptStars(batch([transcript("star", "build").replaceAll("/", "\\")]), answer),
        ["one"],
      );
      NodeAssert.deepEqual(channelTranscriptStars(batch([transcript("star", "user")]), answer), []);
      NodeAssert.deepEqual(channelTranscriptStars(batch([transcript("star", "main")]), answer), [
        "one",
      ]);
      NodeAssert.deepEqual(
        channelTranscriptStars(
          batch(["star/.pult/channels/work/notes.md", "star/notes.md"]),
          answer,
        ),
        [],
      );
      NodeAssert.deepEqual(channelTranscriptStars(batch([], true), answer), ["one", "two"]);
    },
  );

  NodeTest.test("channelSettingsStars names the Star whose channel settings file changed", () => {
    NodeAssert.deepEqual(
      channelSettingsStars(batch(["star-2/.pult/channels/settings.yaml"]), answer),
      ["two"],
    );
    NodeAssert.deepEqual(
      channelSettingsStars(batch(["star\\.pult\\channels\\work\\settings.yaml"]), answer),
      ["one"],
    );
    NodeAssert.deepEqual(
      channelSettingsStars(
        batch([
          transcript("star", "work"),
          "star/.pult/channels/work",
          "star/.pult/channels/work/notes/settings.yaml",
          "star/settings.yaml",
        ]),
        answer,
      ),
      [],
    );
    NodeAssert.deepEqual(channelSettingsStars(batch([], true), answer), ["one", "two"]);
  });
});

NodeTest.describe("rotate-on-context as typed", () => {
  NodeTest.test("reads what the plugin reads, empty as removing the key", () => {
    NodeAssert.equal(parseRotateOnContext("400k"), 400_000);
    NodeAssert.equal(parseRotateOnContext(" never "), "never");
    NodeAssert.equal(parseRotateOnContext(""), null);
    for (const refused of ["300", "0k", "1000000k", "250K", "2.5k", "Never"])
      NodeAssert.equal(parseRotateOnContext(refused), undefined, refused);
    NodeAssert.equal(rotateOnContextText(400_000), "400k");
    NodeAssert.equal(rotateOnContextText("never"), "never");
  });
});

NodeTest.describe("decodeAbout", () => {
  NodeTest.test("reads the features", () => {
    NodeAssert.deepEqual(decodeAbout({ features: ["stars"] }), ["stars"]);
    NodeAssert.deepEqual(decodeAbout({ features: [] }), []);
  });

  NodeTest.test("lets a newer plugin's other fields be", () => {
    NodeAssert.deepEqual(decodeAbout({ features: ["stars"], build: "bundled" }), ["stars"]);
  });

  NodeTest.test("reads anything else as no plugin", () => {
    for (const body of [
      undefined,
      null,
      "stars",
      ["stars"],
      {},
      { features: "stars" },
      { features: ["stars", 1] },
      { features: null },
    ])
      NodeAssert.equal(decodeAbout(body), null, JSON.stringify(body));
  });
});

NodeTest.describe("readAbout", () => {
  const credential = { httpBaseUrl: "http://127.0.0.1:3773/", token: "secret" };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  /** `about` read over a server answering `answer`, with what it was asked. */
  async function readOver(answer: () => Response | Promise<Response>) {
    const asked: Array<{ url: string; authorization: string | null }> = [];
    const fetch = globalThis.fetch;
    const warn = console.warn;
    globalThis.fetch = async (input, init) => {
      asked.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return answer();
    };
    console.warn = () => {};
    try {
      return { features: await readAbout(credential), asked };
    } finally {
      globalThis.fetch = fetch;
      console.warn = warn;
    }
  }

  NodeTest.test("asks the plugin's route with the bearer", async () => {
    const { features, asked } = await readOver(() => json({ features: ["stars"] }));
    NodeAssert.deepEqual(features, ["stars"]);
    NodeAssert.deepEqual(asked, [
      { url: "http://127.0.0.1:3773/api/plugins/pult/about", authorization: "Bearer secret" },
    ]);
  });

  NodeTest.test("reads a server without the plugin as none", async () => {
    // The loader's 404 for an unknown plugin; a stock server's web app page; JSON of another shape; a refusal.
    for (const answer of [
      () => new Response(null, { status: 404 }),
      () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      () => json({ plugins: [] }),
      () => json({ features: ["stars"] }, 401),
      () => new Response("{", { headers: { "content-type": "application/json" } }),
    ])
      NodeAssert.deepEqual((await readOver(answer)).features, []);
  });

  NodeTest.test("reads a server out of reach as none", async () => {
    const { features } = await readOver(() => Promise.reject(new TypeError("fetch failed")));
    NodeAssert.deepEqual(features, []);
  });
});

const star = {
  id: "s1",
  name: "Vega",
  description: "A helpful Star",
  tint: "mint",
  created: "2026-11-01T00:00:00.000Z",
  root: "/Users/a/.pult/stars/star",
  projectId: "p1",
  instructions: "/Users/a/.pult/stars/star/instructions.md",
  defaultChannel: "user",
  channels: [
    { slug: "user", threadId: "t1", sleeps: { at: "2026-11-02T00:10:00.000Z" } },
    { slug: "work", threadId: "t2", sleeps: { heldBy: "run" } },
  ],
  asleepSince: "2026-11-01T00:00:00.000Z",
  model: {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  },
  conversations: ["2026-11-01T10-00-00Z-t0.md"],
  schedules: [
    {
      name: "morning",
      title: "Morning brief",
      path: "/Users/a/.pult/stars/star/.pult/schedules/morning.md",
      rule: "weekdays 09:00",
      kind: "daily",
      timezone: "America/Argentina/Buenos_Aires",
      channel: "work",
      next: "2026-11-11T12:00:00.000Z",
      spent: false,
      problem: null,
      last: {
        due: "2026-11-10T12:00:00.000Z",
        fired: "2026-11-10T12:00:03.000Z",
        result: "failed",
        error: "no conversation ended here yet",
        thread: null,
      },
    },
    {
      name: "typo",
      title: null,
      path: "/Users/a/.pult/stars/star/.pult/schedules/typo.md",
      rule: null,
      kind: null,
      timezone: null,
      channel: null,
      next: null,
      spent: false,
      problem: "it has no `timezone`, an IANA name",
      last: null,
    },
  ],
};
const stars = { directory: "/Users/a/.pult/stars", hidden: ["p1", "p2"], stars: [star] };
/** `stars` as decoded: a newer plugin serves no `histories`. */
const decoded = { ...stars, stars: [{ ...star, histories: undefined }] };

NodeTest.describe("decodeStars", () => {
  NodeTest.test("reads the route's answer, a newer plugin's fields let be", () => {
    NodeAssert.deepEqual(decodeStars(stars), decoded);
    NodeAssert.deepEqual(
      decodeStars({ ...stars, stars: [{ ...star, mood: "calm" }], build: 4 }),
      decoded,
    );
    // An older plugin's channel histories, read where its answer has them; a newer one lists a channel's on its own route.
    const histories = [{ slug: "demo", names: ["2026-11-01T10-00-00Z-t0.md"] }];
    NodeAssert.deepEqual(decodeStars({ ...stars, stars: [{ ...star, histories }] }), {
      ...stars,
      stars: [{ ...star, histories }],
    });
  });

  NodeTest.test("reads a plugin older than the schedules as serving none", () => {
    const { schedules: _, ...older } = star;
    NodeAssert.deepEqual(decodeStars({ ...stars, stars: [older] }).stars[0]?.schedules, []);
  });

  NodeTest.test(
    "reads a schedule from a plugin older than titles, kinds and channels as naming none",
    () => {
      const { title: _, kind: __, channel: ___, ...older } = star.schedules[0] ?? {};
      const answer = { ...stars, stars: [{ ...star, schedules: [older] }] };
      NodeAssert.equal(decodeStars(answer).stars[0]?.schedules[0]?.title, null);
      NodeAssert.equal(decodeStars(answer).stars[0]?.schedules[0]?.kind, null);
      NodeAssert.equal(decodeStars(answer).stars[0]?.schedules[0]?.channel, null);
    },
  );

  NodeTest.test("reads a plugin older than the model as naming none", () => {
    const { model: _, ...older } = star;
    NodeAssert.equal(decodeStars({ ...stars, stars: [older] }).stars[0]?.model, null);
  });

  NodeTest.test("reads each open channel with its deadline or its hold", () => {
    NodeAssert.deepEqual(decodeStars(stars).stars[0]?.channels, [
      { slug: "user", threadId: "t1", sleeps: { at: "2026-11-02T00:10:00.000Z" } },
      { slug: "work", threadId: "t2", sleeps: { heldBy: "run" } },
    ]);
    const asleep = { ...star, channels: [] };
    NodeAssert.deepEqual(decodeStars({ ...stars, stars: [asleep] }).stars[0]?.channels, []);
  });

  NodeTest.test(
    "reads an absent `channels` as none open, and lets an old `conversation` be",
    () => {
      const { channels: _, ...older } = star;
      const old = { ...older, conversation: { threadId: "t1", sleeps: { at: star.created } } };
      NodeAssert.deepEqual(decodeStars({ ...stars, stars: [old] }).stars[0]?.channels, []);
    },
  );

  NodeTest.test(
    "takes a run result or a kind it does not know, so a newer plugin hides no Star",
    () => {
      const newer = {
        ...stars,
        stars: [
          {
            ...star,
            schedules: [
              { ...star.schedules[0], last: { ...star.schedules[0]?.last, result: "claimed" } },
            ],
          },
        ],
      };
      NodeAssert.equal(decodeStars(newer).stars[0]?.schedules[0]?.last?.result, "claimed");
      const monthly = {
        ...stars,
        stars: [{ ...star, schedules: [{ ...star.schedules[0], kind: "monthly" }] }],
      };
      NodeAssert.equal(decodeStars(monthly).stars[0]?.schedules[0]?.kind, null);
    },
  );

  NodeTest.test("fails loudly on any other shape", () => {
    for (const body of [
      null,
      [],
      { ...stars, directory: 1 },
      { ...stars, hidden: "p1" },
      { ...stars, stars: [{ ...star, projectId: null }] },
      // An answer without the default channel is an older plugin's, which the page does not read.
      { ...stars, stars: [{ ...star, defaultChannel: undefined }] },
      { ...stars, stars: [{ ...star, conversations: [1] }] },
      { ...stars, stars: [{ ...star, channels: [{ slug: "work", threadId: "t1", sleeps: {} }] }] },
      { ...stars, stars: [{ ...star, channels: [{ threadId: "t1", sleeps: { heldBy: "run" } }] }] },
      { ...stars, stars: [{ ...star, channels: null }] },
      { ...stars, stars: [{ ...star, schedules: null }] },
      { ...stars, stars: [{ ...star, schedules: [{ ...star.schedules[1], spent: "no" }] }] },
      { ...stars, stars: [{ ...star, schedules: [{ ...star.schedules[0], title: 1 }] }] },
      { ...stars, stars: [{ ...star, schedules: [{ ...star.schedules[0], kind: 1 }] }] },
      {
        ...stars,
        stars: [
          {
            ...star,
            schedules: [{ ...star.schedules[0], last: { ...star.schedules[0]?.last, result: 1 } }],
          },
        ],
      },
      { ...stars, stars: [{ ...star, model: { instanceId: "codex" } }] },
      { hidden: [], stars: [] },
    ])
      NodeAssert.throws(() => decodeStars(body), PluginAnswerError, JSON.stringify(body));
  });
});

NodeTest.describe("decodeChannelTranscripts", () => {
  NodeTest.test("reads a channel's names, and fails loudly on any other shape", () => {
    const names = ["2026-11-01T10-00-00Z-t0.md", "2026-11-02T10-00-00Z-t1.md"];
    NodeAssert.deepEqual(decodeChannelTranscripts({ names }), names);
    for (const body of [null, names, { names: [1] }, {}])
      NodeAssert.throws(() => decodeChannelTranscripts(body), PluginAnswerError);
  });
});

NodeTest.describe("decodeTranscript", () => {
  const transcript = {
    threadId: "t0",
    started: "2026-11-01T10:00:00.000Z",
    ended: "2026-11-01T11:00:00.000Z",
    environment: "Mac",
    title: "Hello",
    partial: false,
    entries: [
      { kind: "user", at: "2026-11-01T10:00:00.000Z", text: "hi" },
      { kind: "tool", at: "2026-11-01T10:00:01.000Z", text: "Read a.md" },
      { kind: "star", at: "2026-11-01T10:00:02.000Z", text: "hello", messageId: "m1" },
      { kind: "star", at: "2026-11-01T10:00:03.000Z", text: "older" },
    ],
  };

  NodeTest.test(
    "reads a transcript's entries, a reply's message id null where it names none",
    () => {
      NodeAssert.deepStrictEqual(decodeTranscript(transcript), {
        ...transcript,
        entries: transcript.entries.map((entry) => ({ messageId: null, ...entry })),
      });
    },
  );

  NodeTest.test(
    "fails loudly on an entry of another kind, a missing field or a message id of another shape",
    () => {
      NodeAssert.throws(
        () => decodeTranscript({ ...transcript, entries: [{ kind: "system", at: "", text: "" }] }),
        PluginAnswerError,
      );
      NodeAssert.throws(
        () => decodeTranscript({ ...transcript, partial: "no" }),
        PluginAnswerError,
      );
      NodeAssert.throws(
        () =>
          decodeTranscript({
            ...transcript,
            entries: [{ ...transcript.entries[2], messageId: 7 }],
          }),
        PluginAnswerError,
      );
    },
  );
});

NodeTest.describe("the Stars' routes", () => {
  const credential = { httpBaseUrl: "http://127.0.0.1:3773/", token: "secret" };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** A route asked over a server answering `answer`, with what it was asked. */
  async function askOver<T>(answer: () => Response, call: () => Promise<T>) {
    const asked: Array<{
      method: string;
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      asked.push({
        method: init?.method ?? "GET",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answer();
    };
    try {
      return { result: await call().catch((error: unknown) => error), asked };
    } finally {
      globalThis.fetch = fetch;
    }
  }

  NodeTest.test("reads the Stars with the bearer", async () => {
    const { result, asked } = await askOver(
      () => json(stars),
      () => readStars(credential),
    );
    NodeAssert.deepEqual(result, decoded);
    NodeAssert.deepEqual(asked, [
      {
        method: "GET",
        url: "http://127.0.0.1:3773/api/plugins/pult/stars",
        authorization: "Bearer secret",
        body: undefined,
      },
    ]);
  });

  NodeTest.test("writes by the Star's id alone", async () => {
    // The write routes answer the Star's record, folder and project alone.
    const written = {
      id: star.id,
      name: star.name,
      description: star.description,
      tint: star.tint,
      created: star.created,
      root: star.root,
      projectId: star.projectId,
    };
    const created = await askOver(
      () => json(written),
      () => createStarOn(credential, { ifNone: true }),
    );
    NodeAssert.deepEqual(created.asked[0]?.body, { ifNone: true });
    NodeAssert.deepEqual(created.result, written);
    const patched = await askOver(
      () => json(written),
      () => writeStarRecord(credential, "s/1", { tint: "rose" }),
    );
    NodeAssert.deepEqual(
      patched.asked.map((each) => [each.method, each.url, each.body]),
      [["POST", "http://127.0.0.1:3773/api/plugins/pult/stars/s%2F1", { tint: "rose" }]],
    );
    const read = await askOver(
      () => json({}),
      () => readStarTranscript(credential, "s1", "2026-11-01T10-00-00Z-t0.md"),
    );
    NodeAssert.equal(
      read.asked[0]?.url,
      "http://127.0.0.1:3773/api/plugins/pult/stars/s1/conversations/2026-11-01T10-00-00Z-t0.md",
    );
    NodeAssert.ok(read.result instanceof PluginAnswerError);
    const found = {
      name: "2026-11-01T10-00-00Z-t_0.md",
      threadId: "t:0",
      started: "a",
      ended: "b",
      environment: "Mac",
      title: "t",
      partial: false,
      entries: [{ kind: "star", at: "a", text: "hi", messageId: "m1" }],
    };
    const looked = await askOver(
      () => json(found),
      () => readStarTranscriptOfThread(credential, "s1", "t:0"),
    );
    NodeAssert.equal(
      looked.asked[0]?.url,
      "http://127.0.0.1:3773/api/plugins/pult/stars/s1/conversations/by-thread?threadId=t%3A0",
    );
    NodeAssert.deepEqual(looked.result, found);
    const unnamed = await askOver(
      () => json({ ...found, name: undefined }),
      () => readStarTranscriptOfThread(credential, "s1", "t:0"),
    );
    NodeAssert.ok(unnamed.result instanceof PluginAnswerError);
  });

  NodeTest.test(
    "reads the asks, and acts on one by its id, reading the plugin's refusal",
    async () => {
      const ask = {
        id: "a1b2c3d4",
        title: "Which backend?",
        status: "posted",
        file: "/Users/a/repo/design.md",
        poster: { star: "s1", channel: "ask-model" },
        posted: "2026-11-21T12:00:00.000Z",
        replied: null,
        snoozedUntil: null,
        settled: null,
        replies: ["Postgres", "SQLite"],
      };
      const prefix = '[In reply to your ask a1b2c3d4 "Which backend?", to your channel ask-model]';
      const read = await askOver(
        () => json({ folder: "/Users/a/.pult/asks", projectId: null, asks: [{ ...ask, prefix }] }),
        () => readAsks(credential),
      );
      NodeAssert.deepEqual(read.result, {
        folder: "/Users/a/.pult/asks",
        projectId: null,
        asks: [{ ...ask, prefix }],
      });
      const thread = { ...ask, poster: { thread: "t9" } };
      const misshapen = await askOver(
        () => json({ folder: "/f", projectId: null, asks: [{ ...thread, poster: {} }] }),
        () => readAsks(credential),
      );
      NodeAssert.ok(misshapen.result instanceof PluginAnswerError);
      const snoozed = { ...thread, status: "snoozed", snoozedUntil: "2026-11-22T09:00:00.000Z" };
      const acted = await askOver(
        // A plugin older than the replies serves none.
        () => json({ ...snoozed, replies: undefined }),
        () => actOnAsk(credential, "a1b2c3d4", { kind: "snooze", until: snoozed.snoozedUntil }),
      );
      NodeAssert.deepEqual(
        acted.asked.map((each) => [each.method, each.url, each.body]),
        [
          [
            "POST",
            "http://127.0.0.1:3773/api/plugins/pult/asks/a1b2c3d4/snooze",
            { until: "2026-11-22T09:00:00.000Z" },
          ],
        ],
      );
      NodeAssert.deepEqual(acted.result, { ...snoozed, replies: [] });
      const failed = await askOver(
        () =>
          json(
            { error: "Pult could not tell the poster of the settle, so the ask is not settled." },
            500,
          ),
        () => actOnAsk(credential, "a1b2c3d4", { kind: "settle" }),
      );
      NodeAssert.deepEqual(
        [failed.asked[0]?.body, (failed.result as Error).message],
        [undefined, "Pult could not tell the poster of the settle, so the ask is not settled."],
      );
    },
  );

  NodeTest.test("asks a Star's channel to sleep, reading the hold that refused it", async () => {
    const slept = await askOver(
      () => json({ slept: true }),
      () => sleepChannelOn(credential, "s1", "main"),
    );
    NodeAssert.deepEqual(
      slept.asked.map((each) => [each.method, each.url, each.body]),
      [["POST", "http://127.0.0.1:3773/api/plugins/pult/stars/s1/sleep", { channel: "main" }]],
    );
    NodeAssert.deepEqual(slept.result, { slept: true });
    const held = await askOver(
      () => json({ slept: false, heldBy: "subagent" }),
      () => sleepChannelOn(credential, "s1", "main"),
    );
    NodeAssert.deepEqual(held.result, { slept: false, heldBy: "subagent" });
    const misshapen = await askOver(
      () => json({ slept: false }),
      () => sleepChannelOn(credential, "s1", "main"),
    );
    NodeAssert.ok(misshapen.result instanceof PluginAnswerError);
  });

  NodeTest.test(
    "asks the model a page's own wake of a channel takes at its mode, the options kept",
    async () => {
      const chosen = {
        instanceId: "codex",
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const asked = await askOver(
        () => json({ model: chosen }),
        () => readWakeModel(credential, "s1", "full-access", "review"),
      );
      NodeAssert.deepEqual(
        asked.asked.map((each) => [each.method, each.url, each.body]),
        [
          [
            "POST",
            "http://127.0.0.1:3773/api/plugins/pult/stars/s1/model",
            { runtimeMode: "full-access", channel: "review" },
          ],
        ],
      );
      NodeAssert.deepEqual(asked.result, chosen);
      const none = await askOver(
        () => json({ model: null }),
        () => readWakeModel(credential, "s1", "auto", "main"),
      );
      NodeAssert.equal(none.result, null);
      const misshapen = await askOver(
        () => json({}),
        () => readWakeModel(credential, "s1", "auto", "main"),
      );
      NodeAssert.ok(misshapen.result instanceof PluginAnswerError);
    },
  );

  NodeTest.test("reads and writes a channel's settings, the model's options kept", async () => {
    const settings = {
      model: {
        instanceId: "codex",
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      modelFrom: "channel",
      rotateOnContext: 400_000,
      rotateFrom: "shared",
      asleepSince: null,
      problems: ['`rotate-on-context` in `.pult/channels/settings.yaml` "300" is neither…'],
    };
    const read = await askOver(
      () => json({ ...settings, later: true }),
      () => readStarChannelSettings(credential, "s1", "ui-batch-5"),
    );
    NodeAssert.deepEqual(
      read.asked.map((each) => [each.method, each.url, each.body]),
      [
        [
          "GET",
          "http://127.0.0.1:3773/api/plugins/pult/stars/s1/channels/ui-batch-5/settings",
          undefined,
        ],
      ],
    );
    NodeAssert.deepEqual(read.result, settings);
    const written = await askOver(
      () => json({ ...settings, rotateOnContext: "never", rotateFrom: "channel" }),
      () => writeStarChannelSettings(credential, "s1", "ui-batch-5", { rotateOnContext: "never" }),
    );
    NodeAssert.deepEqual(
      written.asked.map((each) => [each.method, each.url, each.body]),
      [
        [
          "POST",
          "http://127.0.0.1:3773/api/plugins/pult/stars/s1/channels/ui-batch-5/settings",
          { rotateOnContext: "never" },
        ],
      ],
    );
    NodeAssert.deepEqual(written.result, {
      ...settings,
      rotateOnContext: "never",
      rotateFrom: "channel",
    });
    for (const misshapen of [
      { ...settings, modelFrom: "file" },
      { ...settings, rotateOnContext: "250k" },
      { ...settings, problems: undefined },
    ]) {
      const asked = await askOver(
        () => json(misshapen),
        () => readStarChannelSettings(credential, "s1", "main"),
      );
      NodeAssert.ok(asked.result instanceof PluginAnswerError);
    }
  });

  NodeTest.test("tells the plugin's refusal, and an answer that is no JSON", async () => {
    const refused = await askOver(
      () => json({ error: "No Star has this id on this server." }, 404),
      () => writeStarRecord(credential, "gone", { name: "x" }),
    );
    NodeAssert.ok(refused.result instanceof Error);
    NodeAssert.equal((refused.result as Error).message, "No Star has this id on this server.");
    const page = await askOver(
      () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
      () => readStars(credential),
    );
    NodeAssert.ok(page.result instanceof PluginAnswerError);
  });
});
