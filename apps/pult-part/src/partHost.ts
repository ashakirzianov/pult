// @effect-diagnostics nodeBuiltinImport:off
/**
 * What every Pult server part needs to sit beside the server: it reads the
 * handshake from fd 3, serves plain MCP at `/mcp` and its own routes on a
 * loopback port, refuses any request without the server's secret, and
 * reports its port on fd 4. The protocol is `@t3tools/shared/pult/partProtocol`.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  PART_CALLER_META_KEY,
  PART_HANDSHAKE_FD,
  PART_READY_FD,
  PartCaller,
  PartHandshake,
  PartReady,
} from "@t3tools/shared/pult/partProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

/** The handshake the server sent: its URL and bearer, the secret, the data directory. */
export class Host extends Context.Service<Host, PartHandshake>()("@pult/part/partHost/Host") {}

class PartHostError extends Schema.TaggedError<PartHostError>()("PartHostError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** One MCP tool; it appears to agents beside the host's own, so name it distinctly. */
export interface PartTool<R> {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema with `type: "object"` at the top, as MCP requires. */
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
  /** `caller` is the provider session the call came from, when the server forwarded it. */
  readonly handle: (
    args: unknown,
    caller: Option.Option<PartCaller>,
  ) => Effect.Effect<McpSchema.CallToolResult, never, R>;
}

const PROTOCOL_VERSION = "2025-06-18";

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const decodeJsonRpcRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));
const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
  _meta: Schema.optional(Schema.Struct({ [PART_CALLER_META_KEY]: Schema.optional(PartCaller) })),
});
const decodeToolCallParams = Schema.decodeUnknownOption(ToolCallParams);
const encodeCallToolResult = Schema.encodeEffect(Schema.toCodecJson(McpSchema.CallToolResult));
const decodeHandshake = Schema.decodeUnknownEffect(Schema.fromJsonString(PartHandshake));
const encodeReady = Schema.encodeSync(Schema.fromJsonString(PartReady));

const readHandshake = Effect.try({
  try: () => NodeFS.readFileSync(PART_HANDSHAKE_FD, "utf8"),
  catch: (cause) =>
    new PartHostError({
      detail: `Could not read the handshake on fd ${PART_HANDSHAKE_FD}.`,
      cause,
    }),
}).pipe(
  Effect.flatMap(decodeHandshake),
  Effect.mapError((error) =>
    error._tag === "PartHostError"
      ? error
      : new PartHostError({ detail: "The handshake is malformed.", cause: error }),
  ),
);

/** The `/mcp` route: initialize, ping, tools/list and tools/call, answered as plain JSON. */
export const mcpRoute = <R>(tools: ReadonlyArray<PartTool<R>>) =>
  HttpRouter.add(
    "POST",
    "/mcp",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      const message = decodeJsonRpcRequest(body);
      if (Option.isNone(message)) {
        return HttpServerResponse.jsonUnsafe(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400 },
        );
      }
      const { id, method, params } = message.value;
      // A notification needs no answer.
      if (id === undefined) return HttpServerResponse.empty({ status: 202 });
      const reply = (result: unknown) =>
        HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result });
      const fail = (code: number, text: string) =>
        HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, error: { code, message: text } });
      switch (method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "pult-part", version: "0.0.0" },
          });
        case "ping":
          return reply({});
        case "tools/list":
          return reply({
            tools: tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
        case "tools/call": {
          const call = decodeToolCallParams(params);
          const tool = Option.flatMap(call, ({ name }) =>
            Option.fromUndefinedOr(tools.find((candidate) => candidate.name === name)),
          );
          if (Option.isNone(call) || Option.isNone(tool)) {
            return fail(-32602, "Unknown tool or malformed call.");
          }
          const caller = Option.fromUndefinedOr(call.value._meta?.[PART_CALLER_META_KEY]);
          const result = yield* tool.value.handle(call.value.arguments ?? {}, caller);
          return yield* encodeCallToolResult(result).pipe(
            Effect.match({
              onFailure: () => fail(-32603, `${tool.value.name} returned a malformed result.`),
              onSuccess: reply,
            }),
          );
        }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    }),
  );

/** Every request must carry the secret: the server forwards them, nothing else may. */
const requireSecret = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim());
      const authorized =
        request.headers.authorization === `Bearer ${host.secret}` ||
        protocols?.includes(`pult-part.${host.secret}`) === true;
      return authorized ? yield* httpEffect : HttpServerResponse.empty({ status: 401 });
    }),
  { global: true },
);

const reportReady = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* new PartHostError({ detail: "The part is not listening on a port." });
    }
    const line = `${encodeReady({ port: server.address.port })}\n`;
    yield* Effect.try({
      try: () => NodeFS.writeSync(PART_READY_FD, line),
      catch: (cause) =>
        new PartHostError({ detail: `Could not report readiness on fd ${PART_READY_FD}.`, cause }),
    });
  }),
);

/**
 * The whole part: its tools and its routes, served on a loopback port behind
 * the secret, with readiness reported once it listens. Launch it with
 * `Layer.launch`.
 */
export const partLayer = <R, E, RR>(options: {
  readonly tools: ReadonlyArray<PartTool<R>>;
  readonly routes: Layer.Layer<never, E, RR>;
}) =>
  Layer.mergeAll(
    HttpRouter.serve(
      Layer.mergeAll(mcpRoute(options.tools), options.routes).pipe(Layer.provide(requireSecret)),
      { disableLogger: true },
    ),
    reportReady,
  ).pipe(
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(Layer.effect(Host, readHandshake)),
  );
