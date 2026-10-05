// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PART_CALLER_META_KEY } from "@t3tools/shared/pult/partProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PultPart from "./PultPart.ts";
import * as PultPartTools from "./PultPartTools.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-part-test"),
  threadId: ThreadId.make("thread-part-test"),
  providerSessionId: "provider-session-part-test",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "part-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "part-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const inputSchema = { type: "object", properties: {} } as const;

/**
 * A part's MCP endpoint: lists `part_echo` and `host_tool`, and answers a
 * call over an event stream with what it received.
 */
const fakePartMcp = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeHttp.Server>((resolve) => {
        const server = NodeHttp.createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            const message = JSON.parse(body);
            if (message.id === undefined) {
              response.writeHead(202).end();
              return;
            }
            const reply = (result: unknown) =>
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
            if (message.method === "initialize") {
              response.writeHead(200, {
                "content-type": "application/json",
                "mcp-session-id": "part-session",
              });
              response.end(
                reply({
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fake-part", version: "1" },
                }),
              );
              return;
            }
            if (message.method === "tools/list") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                reply({
                  tools: [
                    { name: "part_echo", description: "Echoes.", inputSchema },
                    { name: "host_tool", description: "Collides.", inputSchema },
                  ],
                }),
              );
              return;
            }
            const echoed = JSON.stringify({
              params: message.params,
              authorization: request.headers.authorization,
              session: request.headers["mcp-session-id"],
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              `event: message\ndata: ${reply({ content: [{ type: "text", text: echoed }] })}\n\n`,
            );
          });
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.sync(() => server.close()),
);

const callTool = (name: string) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: { word: "hi" } })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
  });

const resultText = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

it.live("registers the part's tools on the host server and forwards calls with the caller", () =>
  Effect.gen(function* () {
    const fake = yield* fakePartMcp;
    const address = fake.address();
    if (address === null || typeof address === "string") return yield* Effect.die("no port");
    const state = yield* SubscriptionRef.make<PultPart.PultPartState>({ _tag: "Absent" });
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({ name: "host_tool", inputSchema }),
      annotations: Context.empty(),
      handle: () =>
        Effect.succeed(new McpSchema.CallToolResult({ content: [{ type: "text", text: "host" }] })),
    });
    yield* Layer.build(
      PultPartTools.registrationLayer.pipe(
        Layer.provide(Layer.succeed(PultPart.PultPart, PultPart.PultPart.of({ state }))),
      ),
    );
    const gate = yield* PultPart.PultPartGate;

    yield* SubscriptionRef.set(state, {
      _tag: "Ready",
      dir: "/builds/a/part",
      origin: `http://127.0.0.1:${address.port}`,
      secret: "part-secret",
    });
    yield* gate.await;

    expect(resultText(yield* callTool("host_tool"))).toBe("host");
    const echoed = JSON.parse(resultText(yield* callTool("part_echo")));
    expect(echoed).toEqual({
      params: {
        name: "part_echo",
        arguments: { word: "hi" },
        _meta: {
          [PART_CALLER_META_KEY]: {
            environmentId: invocation.environmentId,
            threadId: invocation.threadId,
            providerSessionId: invocation.providerSessionId,
            providerInstanceId: invocation.providerInstanceId,
          },
        },
      },
      authorization: "Bearer part-secret",
      session: "part-session",
    });

    yield* SubscriptionRef.set(state, { _tag: "Down", reason: "the part exited" });
    const whileDown = yield* callTool("part_echo");
    expect(whileDown.isError).toBe(true);
    expect(resultText(whileDown)).toContain("not running");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(McpServer.McpServer.layer, PultPart.gateLayer, FetchHttpClient.layer),
    ),
    Effect.scoped,
  ),
);

const gatedIssue = Effect.gen(function* () {
  const issued: Array<string> = [];
  const registry = yield* Layer.build(
    PultPartTools.gatedSessionRegistry(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        issue: (request) =>
          Effect.sync(() => {
            issued.push(request.threadId);
            return { config: {} as McpSessionRegistry.McpIssuedCredential["config"] };
          }),
      }),
    ),
  ).pipe(Effect.map((context) => Context.get(context, McpSessionRegistry.McpSessionRegistry)));
  const issuing = yield* registry
    .issue({ threadId: invocation.threadId, providerInstanceId: invocation.providerInstanceId })
    .pipe(Effect.forkChild);
  yield* Effect.yieldNow;
  return { issued, issuing };
});

it.effect("a new session's credentials wait until the part's tools are known", () =>
  Effect.gen(function* () {
    const { issued, issuing } = yield* gatedIssue;
    expect(issued).toEqual([]);
    yield* (yield* PultPart.PultPartGate).settle;
    yield* Fiber.join(issuing);
    expect(issued).toEqual([invocation.threadId]);
  }).pipe(Effect.provide(PultPart.gateLayer), Effect.scoped),
);

it.effect("a new session starts without the part's tools once the wait runs out", () =>
  Effect.gen(function* () {
    const { issued, issuing } = yield* gatedIssue;
    yield* TestClock.adjust("14 seconds");
    expect(issued).toEqual([]);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(issuing);
    expect(issued).toEqual([invocation.threadId]);
  }).pipe(Effect.provide(PultPart.gateLayer), Effect.scoped),
);
