// Run with `node --test src/stars/plugin.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { decodeAbout, readAbout } from "./plugin.ts";

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
