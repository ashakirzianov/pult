// Run with `node --test src/stars/plugin.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  createStarOn,
  decodeAbout,
  decodeStars,
  decodeTranscript,
  writeStarRecord,
  PluginAnswerError,
  readAbout,
  readStars,
  readStarTranscript,
} from "./plugin.ts";

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
  tint: "mint",
  created: "2026-11-01T00:00:00.000Z",
  root: "/Users/a/.pult/stars/star",
  projectId: "p1",
  instructions: "/Users/a/.pult/stars/star/instructions.md",
  conversation: { threadId: "t1", sleeps: { at: "2026-11-02T00:10:00.000Z" } },
  asleepSince: "2026-11-01T00:00:00.000Z",
  conversations: ["2026-11-01T10-00-00Z-t0.md"],
  schedules: [
    {
      name: "morning",
      path: "/Users/a/.pult/stars/star/.pult/schedules/morning.md",
      rule: "weekdays 09:00",
      timezone: "America/Argentina/Buenos_Aires",
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
      path: "/Users/a/.pult/stars/star/.pult/schedules/typo.md",
      rule: null,
      timezone: null,
      next: null,
      spent: false,
      problem: "it has no `timezone`, an IANA name",
      last: null,
    },
  ],
};
const stars = { directory: "/Users/a/.pult/stars", hidden: ["p1", "p2"], stars: [star] };

NodeTest.describe("decodeStars", () => {
  NodeTest.test("reads the route's answer, a newer plugin's fields let be", () => {
    NodeAssert.deepEqual(decodeStars(stars), stars);
    NodeAssert.deepEqual(
      decodeStars({ ...stars, stars: [{ ...star, asks: [] }], build: 4 }),
      stars,
    );
  });

  NodeTest.test("reads a plugin older than the schedules as serving none", () => {
    const { schedules: _, ...older } = star;
    NodeAssert.deepEqual(decodeStars({ ...stars, stars: [older] }).stars[0]?.schedules, []);
  });

  NodeTest.test("reads a conversation's hold, and a sleeping Star's none", () => {
    const held = { ...star, conversation: { threadId: "t1", sleeps: { heldBy: "run" } } };
    NodeAssert.deepEqual(decodeStars({ ...stars, stars: [held] }).stars[0]?.conversation, {
      threadId: "t1",
      sleeps: { heldBy: "run" },
    });
    const asleep = { ...star, conversation: null };
    NodeAssert.equal(decodeStars({ ...stars, stars: [asleep] }).stars[0]?.conversation, null);
  });

  NodeTest.test("takes a run result it does not know, so a newer plugin hides no Star", () => {
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
  });

  NodeTest.test("fails loudly on any other shape", () => {
    for (const body of [
      null,
      [],
      { ...stars, directory: 1 },
      { ...stars, hidden: "p1" },
      { ...stars, stars: [{ ...star, projectId: null }] },
      { ...stars, stars: [{ ...star, conversations: [1] }] },
      { ...stars, stars: [{ ...star, conversation: { threadId: "t1", sleeps: {} } }] },
      { ...stars, stars: [{ ...star, schedules: null }] },
      { ...stars, stars: [{ ...star, schedules: [{ ...star.schedules[1], spent: "no" }] }] },
      {
        ...stars,
        stars: [
          {
            ...star,
            schedules: [{ ...star.schedules[0], last: { ...star.schedules[0]?.last, result: 1 } }],
          },
        ],
      },
      { hidden: [], stars: [] },
    ])
      NodeAssert.throws(() => decodeStars(body), PluginAnswerError, JSON.stringify(body));
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
      { kind: "star", at: "2026-11-01T10:00:02.000Z", text: "hello" },
    ],
  };

  NodeTest.test("reads a transcript's entries", () => {
    NodeAssert.deepEqual(decodeTranscript(transcript), transcript);
  });

  NodeTest.test("fails loudly on an entry of another kind, or a missing field", () => {
    NodeAssert.throws(
      () => decodeTranscript({ ...transcript, entries: [{ kind: "system", at: "", text: "" }] }),
      PluginAnswerError,
    );
    NodeAssert.throws(() => decodeTranscript({ ...transcript, partial: "no" }), PluginAnswerError);
  });
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
    NodeAssert.deepEqual(result, stars);
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
