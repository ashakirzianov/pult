import { afterEach, describe, expect, it } from "vite-plus/test";
import { PART_CALLER_META_KEY, type PartCaller } from "@t3tools/shared/pult/partProtocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";

import { mcpRoute, type PartTool } from "./partHost.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const caller: PartCaller = {
  environmentId: "environment",
  threadId: "thread",
  providerSessionId: "provider-session",
  providerInstanceId: "claude",
};

const echo: PartTool<never> = {
  name: "part_echo",
  description: "Echoes its call.",
  inputSchema: { type: "object", properties: {} },
  handle: (args, from) =>
    Effect.succeed(
      new McpSchema.CallToolResult({
        content: [{ type: "text", text: "echoed" }],
        structuredContent: { args, caller: Option.getOrNull(from) } as never,
      }),
    ),
};

const post = async (body: unknown) => {
  const { handler, dispose } = HttpRouter.toWebHandler(mcpRoute([echo]), { disableLogger: true });
  disposers.push(dispose);
  const response = await handler(
    new Request("http://part.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
};

describe("part MCP route", () => {
  it("lists its tools and hands a call its arguments and the forwarded caller", async () => {
    const listed = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.body.result.tools).toEqual([
      { name: "part_echo", description: "Echoes its call.", inputSchema: echo.inputSchema },
    ]);
    const called = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "part_echo",
        arguments: { word: "hi" },
        _meta: { [PART_CALLER_META_KEY]: caller },
      },
    });
    expect(called.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "echoed" }],
        structuredContent: { args: { word: "hi" }, caller },
      },
    });
  });

  it("acknowledges notifications and refuses unknown tools and methods", async () => {
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const unknownTool = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(unknownTool.body.error.code).toBe(-32602);
    const unknownMethod = await post({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    expect(unknownMethod.body.error.code).toBe(-32601);
  });
});
