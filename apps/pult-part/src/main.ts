/**
 * Pult's server part. The server runs the build of this file, `main.mjs`,
 * from the live payload build; `vp run pult:stage` builds and stages it with
 * the client.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { Host, partLayer, type PartTool } from "./partHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const status = Effect.gen(function* () {
  const host = yield* Host;
  return {
    build: import.meta.dirname,
    dataDir: host.dataDir,
    now: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
  };
});

/** Proves the round trip: forwarded call, caller identity, and the host's API with the part's bearer. */
const statusTool: PartTool<Host | HttpClient.HttpClient> = {
  name: "pult_part_status",
  description:
    "Reports which build of Pult's server part is running, which session called it, and whether the part reaches the host's API.",
  inputSchema: { type: "object", properties: {} },
  handle: (_args, caller) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const hostApiStatus = yield* HttpClient.get(`${host.serverUrl}/api/auth/session`, {
        headers: { authorization: `Bearer ${host.token}` },
      }).pipe(
        Effect.map((response) => response.status),
        Effect.orElseSucceed(() => 0),
      );
      const result = {
        ...(yield* status),
        caller: Option.getOrNull(caller),
        hostApiStatus,
      };
      return new McpSchema.CallToolResult({
        content: [{ type: "text", text: encodeJson(result) }],
        structuredContent: result,
      });
    }),
};

const routes = HttpRouter.add(
  "GET",
  "/status",
  status.pipe(Effect.map((body) => HttpServerResponse.jsonUnsafe(body))),
);

partLayer({ tools: [statusTool], routes }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
