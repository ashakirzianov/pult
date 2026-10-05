/**
 * The server part's MCP tools, on the host's own `t3-code` server.
 *
 * Each time the part comes up, the host lists the tools it serves on its
 * loopback `/mcp` and registers a forwarding tool for each, so no provider
 * adapter changes and sessions and their credentials stay the host's. A call
 * is forwarded with the caller's identity in `_meta["pult/caller"]` and the
 * part's secret as its bearer. A session's tool list is fixed when it starts,
 * so tools stay listed while the part is down and answer with an error; a
 * part tool named like one of the host's own is not registered.
 */
import { PART_CALLER_META_KEY, type PartCaller } from "@t3tools/shared/pult/partProtocol";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PultPart from "./PultPart.ts";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT = Duration.seconds(10);
/** How long a new provider session waits for the part's tools before it starts without them. */
const SESSION_WAIT = Duration.seconds(15);

class PartMcpError extends Schema.TaggedError<PartMcpError>()("PartMcpError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const JsonRpcResponse = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const decodeJsonRpcResponse = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));
const decodeListToolsResult = Schema.decodeUnknownEffect(
  Schema.toCodecJson(McpSchema.ListToolsResult),
);
const decodeCallToolResult = Schema.decodeUnknownEffect(
  Schema.toCodecJson(McpSchema.CallToolResult),
);

/** A Streamable HTTP response is one JSON message, or an event stream carrying several. */
const responseMessages = (contentType: string, body: string) =>
  (contentType.includes("text/event-stream")
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n"),
        )
        .filter((data) => data.length > 0)
    : [body]
  ).flatMap((text) => Option.toArray(decodeJsonRpcResponse(text)));

/** A minimal MCP client for one run of the part. */
const makePartMcpClient = (httpClient: HttpClient.HttpClient, origin: string, secret: string) => {
  let sessionId: string | undefined;
  let nextId = 0;

  const post = (body: unknown) =>
    httpClient
      .execute(
        HttpClientRequest.post(`${origin}/mcp`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${secret}`,
            "mcp-protocol-version": PROTOCOL_VERSION,
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          }),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            sessionId = response.headers["mcp-session-id"] ?? sessionId;
          }),
        ),
      );

  const request = (method: string, params: unknown) =>
    Effect.gen(function* () {
      nextId += 1;
      const id = nextId;
      const response = yield* post({ jsonrpc: "2.0", id, method, params });
      const body = yield* response.text;
      if (response.status >= 400) {
        return yield* new PartMcpError({
          detail: `The part answered ${method} with HTTP ${response.status}.`,
        });
      }
      const message = responseMessages(response.headers["content-type"] ?? "", body).find(
        (candidate) => candidate.id === id,
      );
      if (message === undefined) {
        return yield* new PartMcpError({ detail: `The part sent no answer to ${method}.` });
      }
      if (message.error !== undefined) {
        return yield* new PartMcpError({ detail: message.error.message });
      }
      return message.result;
    }).pipe(
      Effect.catchTags({
        HttpClientError: (error) => Effect.fail(new PartMcpError({ detail: error.message })),
      }),
    );

  const initialize = request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "pult-host", version: "1" },
  }).pipe(
    Effect.andThen(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }).pipe(
        Effect.mapError((error) => new PartMcpError({ detail: error.message })),
      ),
    ),
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new PartMcpError({ detail: "The part did not initialize." })),
    }),
  );

  const listTools = Effect.gen(function* () {
    const tools: Array<McpSchema.Tool> = [];
    let cursor: string | undefined;
    do {
      const page = yield* request("tools/list", cursor === undefined ? {} : { cursor }).pipe(
        Effect.flatMap(decodeListToolsResult),
        Effect.mapError((error) =>
          error._tag === "PartMcpError" ? error : new PartMcpError({ detail: error.message }),
        ),
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new PartMcpError({ detail: "The part did not list its tools." })),
    }),
  );

  const callTool = (name: string, args: unknown, caller: PartCaller) =>
    request("tools/call", {
      name,
      arguments: args ?? {},
      _meta: { [PART_CALLER_META_KEY]: caller },
    }).pipe(
      Effect.flatMap(decodeCallToolResult),
      Effect.mapError((error) =>
        error._tag === "PartMcpError" ? error : new PartMcpError({ detail: error.message }),
      ),
    );

  return { initialize, listTools, callTool };
};

type PartMcpClient = ReturnType<typeof makePartMcpClient>;

const errorResult = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

export const registrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const part = yield* PultPart.PultPart;
    const gate = yield* PultPart.PultPartGate;
    const httpClient = yield* HttpClient.HttpClient;
    let client: PartMcpClient | undefined;
    const registered = new Set<string>();

    const forward = (name: string) => (payload: unknown) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(part.state);
          if (state._tag !== "Ready" || client === undefined) {
            return errorResult(
              `${name} is served by Pult's server part, which is not running right now. Try again shortly.`,
            );
          }
          return yield* client.callTool(name, payload, {
            environmentId: invocation.environmentId,
            threadId: invocation.threadId,
            providerSessionId: invocation.providerSessionId,
            providerInstanceId: invocation.providerInstanceId,
          });
        }).pipe(
          Effect.catchTag("PartMcpError", (error) =>
            Effect.logWarning("server part tool call failed", { tool: name, error }).pipe(
              Effect.as(errorResult(`${name} failed in Pult's server part: ${error.detail}`)),
            ),
          ),
        );
      });

    const register = (ready: Extract<PultPart.PultPartState, { _tag: "Ready" }>) =>
      Effect.gen(function* () {
        const next = makePartMcpClient(httpClient, ready.origin, ready.secret);
        yield* next.initialize;
        client = next;
        const tools = yield* next.listTools;
        for (const tool of tools) {
          if (!registered.has(tool.name) && server.tools.some((t) => t.tool.name === tool.name)) {
            yield* Effect.logWarning("server part tool is named like a host tool; skipped", {
              tool: tool.name,
            });
            continue;
          }
          yield* server.addTool({
            tool,
            annotations: Context.empty(),
            handle: forward(tool.name),
          });
          registered.add(tool.name);
        }
        yield* Effect.logInfo("server part tools registered", {
          tools: tools.map((tool) => tool.name),
        });
      }).pipe(
        Effect.catchTag("PartMcpError", (error) =>
          Effect.logWarning("could not register the server part's tools", { error }),
        ),
        Effect.ensuring(gate.settle),
      );

    yield* SubscriptionRef.changes(part.state).pipe(
      Stream.runForEach((state) => {
        if (state._tag === "Ready") return register(state);
        client = undefined;
        return Effect.void;
      }),
      Effect.forkScoped,
    );
  }),
);

/**
 * The MCP session registry, issuing a new provider session's credentials only
 * once the part's tools are known (or the wait runs out), since the session's
 * tool list is fixed when it starts.
 */
export const gatedSessionRegistry = <E, R>(
  registry: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>,
) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const inner = yield* McpSessionRegistry.McpSessionRegistry;
      const gate = yield* PultPart.PultPartGate;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...inner,
        issue: (request) =>
          gate.await.pipe(Effect.timeoutOption(SESSION_WAIT), Effect.andThen(inner.issue(request))),
      });
    }),
  ).pipe(Layer.provide(registry));
