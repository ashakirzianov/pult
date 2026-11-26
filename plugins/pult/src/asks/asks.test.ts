import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";

// The real loader, bundled list, MCP server and routes, which the plugin itself never imports.
import * as McpHttpServer from "../../../../apps/server/src/mcp/McpHttpServer.ts";
import { bundledPlugins } from "../../../../apps/server/src/plugins/bundled.ts";
import * as PluginLoader from "../../../../apps/server/src/plugins/PluginLoader.ts";
import * as ExtensionUi from "../../../../apps/server/src/plugins/ExtensionUi.ts";
import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
  McpInvocationContext,
  McpSchema,
  McpServer,
  Path,
} from "../host.ts";
import { at, fakeServer, run } from "../stars/testing.ts";

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "pult-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pult-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scopeOf = (
  caller: { readonly thread: string } | { readonly client: "full-access" },
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session-1",
  thread:
    "thread" in caller
      ? {
          threadId: caller.thread as never,
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client:
    "client" in caller
      ? { sessionId: "client-1", label: "Client", access: caller.client }
      : undefined,
});

const DAY = 24 * 60 * 60_000;

it.effect(
  "threads post, settle and list asks with the pult_ask tools, and the page serves and acts on them by its routes",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
      const server = yield* fakeServer;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provideMerge(ExtensionUi.layer),
          Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
        ),
      );
      const loader = Context.get(context, PluginLoader.PluginLoader);
      const mcp = Context.get(context, McpServer.McpServer);
      const tool = (
        name: string,
        scope: McpInvocationContext.McpInvocationScope,
        args: Record<string, unknown>,
      ) =>
        mcp.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.map((result) => {
            const text = result.content[0];
            const body = text?.type === "text" ? JSON.parse(text.text) : undefined;
            return result.isError === true ? { refused: body.code, message: body.message } : body;
          }),
        );
      const as = (thread: string) => ({
        ask: (args: Record<string, unknown>) => tool("pult_ask", scopeOf({ thread }), args),
        settle: (id: string) => tool("pult_ask_settle", scopeOf({ thread }), { id }),
        list: (args: Record<string, unknown> = {}) =>
          tool("pult_ask_list", scopeOf({ thread }), args),
      });
      // Through the plugin's own route, inside this fiber, so its clock is the test's; the scopes
      // a write needs are the loader's to check, as `main.test.ts` drives it.
      const route = loader.route("pult")!;
      const send = (method: string, at: string, body?: unknown) =>
        Effect.gen(function* () {
          const response = yield* route(
            HttpServerRequest.fromWeb(
              new Request(`http://127.0.0.1/api/plugins/pult${at}`, {
                method,
                headers: { "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            ),
            at,
            [AuthOrchestrationReadScope, AuthAccessWriteScope],
          );
          const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
          return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
        });
      const page = Effect.map(send("GET", "/asks"), (each) => each.body);

      expect((yield* send("GET", "/about")).body.features).toEqual(
        expect.arrayContaining(["asks"]),
      );

      // What agents see of the asks, pinned: the three tools as `tools/list` lists them, and a refusal's text.
      expect(
        mcp.tools
          .filter((entry) => entry.tool.name.startsWith("pult_ask"))
          .map((entry) => JSON.parse(JSON.stringify(entry.tool))),
      ).toMatchInlineSnapshot(`
        [
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
              "title": "Ask the user",
            },
            "description": "Ask the user something in Pult: the ask waits in the user's Inbox until they answer or settle it. Its context is a file: name the one that already says what you need with \`file\`, in this thread's worktree or project folder (absolute, or relative to it), or pass \`text\`, Markdown Pult keeps for you; exactly one of them for a new ask. \`title\` defaults to the context's first line. The user's reply comes as a message to this conversation (for a Star, to the channel that asked) opening \`[In reply to your ask <id> "<title>"…]\`; if the user settles the ask, a message opening \`[From Pult, about your ask <id> "<title>"…]\` tells you so. With the \`id\` of one of your own asks you ask again: it returns to the Inbox, a settled one reopens, and a \`title\` or \`text\` you pass replaces the old, though an ask posted with \`file\` takes no \`text\`: change the file. The same \`file\` posted again without an \`id\` is your open ask of that file, asked again. Settle an ask with \`pult_ask_settle\` once it is answered or no longer needed; a settled ask is removed 7 days after its settle, and its \`id\` is then unknown.",
            "inputSchema": {
              "properties": {
                "file": {
                  "description": "The file the ask is about, which Pult never deletes.",
                  "type": "string",
                },
                "id": {
                  "description": "One of your own asks, to ask it again.",
                  "type": "string",
                },
                "replies": {
                  "description": "1 to 4 reply options, each a distinct single line of at most 200 characters, offered beside the reply input. A click fills the input, the user may edit it before sending, and the reply arrives as any reply does: nothing tells you which option was clicked. Asking again replaces them; left out, the ask has none.",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "text": {
                  "description": "Markdown for Pult to keep as the ask's context, deleted with the ask.",
                  "maxLength": 120000,
                  "type": "string",
                },
                "title": {
                  "description": "One line; by default the context's first line.",
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "pult_ask",
            "outputSchema": {
              "additionalProperties": true,
              "properties": {
                "id": {
                  "type": "string",
                },
                "status": {
                  "anyOf": [
                    {
                      "enum": [
                        "posted",
                      ],
                      "type": "string",
                    },
                  ],
                },
              },
              "required": [
                "id",
                "status",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
              "title": "Settle an ask",
            },
            "description": "Settle one of your own asks in Pult (for a Star, an ask of any of its channels) once it is answered or no longer needed: it leaves the user's Inbox for Settled, and nobody is told. It is removed 7 days after its settle; until then \`pult_ask\` with its \`id\` reopens it.",
            "inputSchema": {
              "properties": {
                "id": {
                  "type": "string",
                },
              },
              "required": [
                "id",
              ],
              "type": "object",
            },
            "name": "pult_ask_settle",
            "outputSchema": {
              "additionalProperties": true,
              "properties": {
                "id": {
                  "type": "string",
                },
                "status": {
                  "anyOf": [
                    {
                      "enum": [
                        "settled",
                      ],
                      "type": "string",
                    },
                  ],
                },
              },
              "required": [
                "id",
                "status",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": true,
              "readOnlyHint": true,
              "title": "List asks",
            },
            "description": "The asks posted in Pult on this server, by default your own: for a Star, every channel's. Name a Star by \`star\` (its id, with \`channel\` for one of its channels) or a thread by \`thread\` to list theirs. Each row has its \`status\`: \`posted\` (in the user's Inbox), \`replied\` (the user replied), \`snoozed\` (until \`snoozedUntil\`), or \`settled\` (\`settled\` is when, its thread's settle for a thread's ask while that thread is settled); settled asks are listed only with \`settled: true\`. Work started from a linked environment lists only its own.",
            "inputSchema": {
              "properties": {
                "channel": {
                  "description": "One of the Star's channels, a slug.",
                  "pattern": "^[a-z0-9][a-z0-9-]{0,50}$",
                  "type": "string",
                },
                "settled": {
                  "description": "Whether to list settled asks too.",
                  "type": "boolean",
                },
                "star": {
                  "description": "A Star's id.",
                  "type": "string",
                },
                "thread": {
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "pult_ask_list",
            "outputSchema": {
              "additionalProperties": true,
              "properties": {
                "asks": {
                  "items": {
                    "additionalProperties": true,
                    "properties": {
                      "file": {
                        "type": "string",
                      },
                      "id": {
                        "type": "string",
                      },
                      "posted": {
                        "type": "string",
                      },
                      "poster": {
                        "anyOf": [
                          {
                            "additionalProperties": true,
                            "properties": {
                              "channel": {
                                "pattern": "^[a-z0-9][a-z0-9-]{0,50}$",
                                "type": "string",
                              },
                              "star": {
                                "type": "string",
                              },
                            },
                            "required": [
                              "star",
                              "channel",
                            ],
                            "type": "object",
                          },
                          {
                            "additionalProperties": true,
                            "properties": {
                              "thread": {
                                "type": "string",
                              },
                            },
                            "required": [
                              "thread",
                            ],
                            "type": "object",
                          },
                        ],
                      },
                      "replied": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "replies": {
                        "items": {
                          "type": "string",
                        },
                        "type": "array",
                      },
                      "settled": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "snoozedUntil": {
                        "anyOf": [
                          {
                            "type": "string",
                          },
                          {
                            "type": "null",
                          },
                        ],
                      },
                      "status": {
                        "enum": [
                          "posted",
                          "replied",
                          "snoozed",
                          "settled",
                        ],
                        "type": "string",
                      },
                      "title": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "id",
                      "title",
                      "status",
                      "file",
                      "poster",
                      "posted",
                      "replied",
                      "snoozedUntil",
                      "settled",
                      "replies",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
              },
              "required": [
                "asks",
              ],
              "type": "object",
            },
          },
        ]
      `);

      // A Star, its conversation with the user open and warm; a worker in a repository's worktree.
      const root = path.join(server.directory, "star");
      yield* fs.makeDirectory(path.join(root, ".pult"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".pult/star.yaml"),
        'id: "vega-id"\nname: "Vega"\ntint: "amber"\ncreated: "2026-11-10T09:00:00.000Z"\n',
      );
      const vega = yield* server.projects.service.create({
        projectId: ProjectId.make("p-star"),
        title: "Vega",
        workspaceRoot: root,
      });
      server.threads.add(
        vega.id,
        "vega-user",
        {
          createdAt: at("2026-11-10T12:50:00.000Z"),
          promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z"),
          runtimeMode: "auto",
          activeRunId: RunId.make("vega-user-run"),
        },
        [run("vega-user-run", "completed")],
      );
      const repo = yield* server.projects.service.create({
        projectId: ProjectId.make("p-repo"),
        title: "Repo",
        workspaceRoot: `${server.tmp}/repo`,
        createWorkspaceRootIfMissing: true,
      });
      const tree = `${server.tmp}/repo-tree`;
      yield* fs.makeDirectory(`${tree}/notes`, { recursive: true });
      yield* fs.writeFileString(`${tree}/notes/q.md`, "\n## Ship the parser?\n\nIt passes.\n");
      const worker = server.threads.add(repo.id, "worker", {
        worktreePath: tree,
        activeRunId: RunId.make("worker-run"),
      });
      const star = as("vega-user");
      const work = as("worker");
      expect(
        yield* mcp
          .callTool({ name: "pult_ask", arguments: { file: "a.md", text: "b" } })
          .pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              scopeOf({ thread: "worker" }),
            ),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          ),
      ).toMatchInlineSnapshot(`
        CallToolResult {
          "content": [
            {
              "text": "{"_tag":"OrchestratorMcpFailure","code":"invalid_request","message":"Pass \`file\` or \`text\`, not both."}",
              "type": "text",
            },
          ],
          "isError": true,
        }
      `);

      // A Star posts Markdown Pult keeps, in the asks folder, registered as a hidden project.
      const posted = yield* star.ask({
        text: "# Which crate?\n\nserde or miniserde.",
        replies: [" serde ", "miniserde"],
      });
      expect(posted).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), status: "posted" });
      const kept = path.join(server.tmp, ".pult", "asks", `${posted.id}.md`);
      expect(yield* fs.readFileString(kept)).toBe("# Which crate?\n\nserde or miniserde.");
      const folder = server.projects.shells.find((each) => each.workspaceRoot.endsWith("/asks"));
      expect((yield* send("GET", "/stars")).body.hidden).toEqual([vega.id, folder?.id]);
      // A thread names a file of its worktree; the same file again is the same open ask.
      yield* TestClock.adjust(1000);
      const filed = yield* work.ask({ file: "notes/q.md" });
      expect(
        yield* work.ask({ file: `${tree}/notes/q.md`, title: "Ship it?", replies: ["Ship it"] }),
      ).toEqual(filed);
      expect(yield* page).toEqual({
        folder: path.join(server.tmp, ".pult", "asks"),
        projectId: folder?.id,
        asks: [
          {
            id: posted.id,
            title: "Which crate?",
            status: "posted",
            file: kept,
            poster: { star: "vega-id", channel: "main" },
            posted: "2026-11-10T13:00:00.000Z",
            replied: null,
            snoozedUntil: null,
            settled: null,
            replies: ["serde", "miniserde"],
            // The header the page's composer attaches to the reply (`messageHeader.ts`), its line as `prefix` for an older page.
            header: {
              extension: "pult",
              line: `[In reply to your ask ${posted.id} "Which crate?", to your channel main]`,
              caption: {
                reply: true,
                lead: "Reply to the ask",
                name: "Which crate?",
                open: { row: posted.id },
                note: null,
              },
            },
            prefix: `[In reply to your ask ${posted.id} "Which crate?", to your channel main]`,
          },
          expect.objectContaining({
            id: filed.id,
            title: "Ship it?",
            file: `${tree}/notes/q.md`,
            poster: { thread: "worker" },
            replies: ["Ship it"],
            header: expect.objectContaining({
              line: `[In reply to your ask ${filed.id} "Ship it?"]`,
            }),
            prefix: `[In reply to your ask ${filed.id} "Ship it?"]`,
          }),
        ],
      });

      // What a post refuses; a named file is one of the poster's folder, which the page opens it in.
      yield* fs.writeFileString(`${server.tmp}/outside.md`, "Out");
      yield* fs.writeFileString(`${root}/notes.md`, "Notes");
      const refusals = [
        yield* work.ask({ file: "../outside.md" }),
        yield* work.ask({}),
        yield* work.ask({ file: "notes/q.md", text: "x" }),
        yield* work.ask({ text: "  \n" }),
        yield* work.ask({ file: "notes/none.md" }),
        yield* work.ask({ id: "00000000", title: "x" }),
        yield* work.ask({ id: posted.id, title: "Mine now" }),
        yield* work.ask({ id: filed.id, text: "Replaced" }),
        yield* star.ask({ id: posted.id, file: "notes.md" }),
      ];
      expect(refusals.map((each) => each.refused)).toEqual(
        Array(refusals.length).fill("invalid_request"),
      );
      expect(refusals[5].message).toContain("expired 7 days after its settle");
      // Reply options break a rule whole: none is dropped or cut.
      const brokenReplies = [
        [[], "pass 1 to 4"],
        [["a", "b", "c", "d", "e"], "pass 1 to 4"],
        [["a", "  "], "option 2 is empty"],
        [["a\nb"], "single line"],
        [[`${"x".repeat(200)} `], "at most 200"],
        [["a", " a "], "option 2 repeats option 1"],
      ] as const;
      for (const [replies, rule] of brokenReplies) {
        const answer = yield* work.ask({ text: "Options", replies });
        expect(answer).toMatchObject({
          refused: "invalid_request",
          message: expect.stringContaining(rule),
        });
      }

      // Lists: by default the caller's own, a Star's every channel; another's by name.
      expect((yield* star.list()).asks.map((each: { id: string }) => each.id)).toEqual([posted.id]);
      expect((yield* work.list()).asks.map((each: { id: string }) => each.id)).toEqual([filed.id]);
      expect((yield* work.list({ star: "vega-id", channel: "work" })).asks).toEqual([]);
      expect((yield* star.list({ thread: "worker" })).asks).toHaveLength(1);
      expect((yield* work.list({ channel: "user" })).refused).toBe("invalid_request");

      // The page's actions: replied, snoozed until a time and woken, settled telling the poster, un-settled.
      expect((yield* send("POST", "/asks/nobody/replied")).status).toBe(404);
      expect((yield* send("POST", `/asks/${posted.id}/snooze`, { until: "later" })).status).toBe(
        400,
      );
      const snooze = { until: "2026-11-11T09:00:00Z" };
      expect((yield* send("POST", `/asks/${posted.id}/snooze`, snooze)).body).toMatchObject({
        status: "snoozed",
        snoozedUntil: "2026-11-11T09:00:00.000Z",
      });
      // A reply moves it to Working, from Snoozed too.
      expect((yield* send("POST", `/asks/${posted.id}/replied`)).body).toMatchObject({
        status: "replied",
        replied: "2026-11-10T13:00:01.000Z",
        snoozedUntil: null,
      });
      yield* send("POST", `/asks/${posted.id}/snooze`, snooze);
      expect((yield* send("POST", `/asks/${posted.id}/snooze`, { until: null })).body.status).toBe(
        "replied",
      );
      expect((yield* send("POST", `/asks/${posted.id}/settle`)).body).toMatchObject({
        status: "settled",
        settled: "2026-11-10T13:00:01.000Z",
      });
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "vega-user",
        text: "The user settled this ask after replying to it. `pult_ask` with its id reopens it for 7 days.",
        header: {
          extension: "pult",
          line: `[From Pult, about your ask ${posted.id} "Which crate?", to your channel main]`,
          caption: {
            reply: false,
            lead: "From Pult, about the ask",
            name: "Which crate?",
            open: { row: posted.id },
            note: null,
          },
        },
        creationSource: "server",
      });
      // Told once: a settle of a settled ask changes nothing.
      const told = server.threads.messages.length;
      yield* send("POST", `/asks/${posted.id}/settle`);
      expect(server.threads.messages).toHaveLength(told);
      expect((yield* star.list()).asks).toEqual([]);
      expect((yield* star.list({ settled: true })).asks).toMatchObject([{ status: "settled" }]);
      expect((yield* send("POST", `/asks/${posted.id}/unsettle`)).body.status).toBe("replied");
      // A plain thread is told in its own thread, here of a settle with no reply.
      yield* send("POST", `/asks/${filed.id}/settle`);
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "worker",
        text: "The user settled this ask without replying to it. `pult_ask` with its id reopens it for 7 days.",
        header: {
          extension: "pult",
          line: `[From Pult, about your ask ${filed.id} "Ship it?"]`,
          caption: {
            reply: false,
            lead: "From Pult, about the ask",
            name: "Ship it?",
            open: { row: filed.id },
            note: null,
          },
        },
      });

      // The poster's own settle is silent, and asking again with the id reopens it, a new text replacing the old.
      expect(yield* star.settle(posted.id)).toEqual({ id: posted.id, status: "settled" });
      expect(server.threads.messages).toHaveLength(told + 1);
      expect((yield* work.settle(posted.id)).refused).toBe("invalid_request");
      expect(yield* star.ask({ id: posted.id, text: "# Which crate, now?" })).toEqual(posted);
      expect((yield* star.list()).asks).toMatchObject([
        { id: posted.id, title: "Which crate, now?", status: "posted", replied: null, replies: [] },
      ]);
      expect(yield* fs.readFileString(kept)).toBe("# Which crate, now?");

      // A plain thread's asks follow it: settled while it is, gone once archived.
      worker.shell = {
        ...worker.shell,
        settledOverride: "settled",
        settledAt: at("2026-11-10T12:30:00.000Z"),
      };
      expect(yield* send("POST", `/asks/${filed.id}/unsettle`)).toMatchObject({ status: 200 });
      expect((yield* page).asks.find((each: { id: string }) => each.id === filed.id)).toMatchObject(
        {
          status: "settled",
          settled: "2026-11-10T12:30:00.000Z",
        },
      );
      expect((yield* send("POST", `/asks/${filed.id}/unsettle`)).status).toBe(409);
      worker.shell = { ...worker.shell, archivedAt: at("2026-11-10T12:40:00.000Z") };
      expect((yield* page).asks.map((each: { id: string }) => each.id)).toEqual([posted.id]);
      expect(yield* fs.exists(`${tree}/notes/q.md`)).toBe(true);

      // A settled ask goes 7 days after its settle, with Pult's Markdown, and its id is then unknown.
      yield* star.settle(posted.id);
      yield* TestClock.adjust(7 * DAY - 1);
      expect((yield* page).asks).toHaveLength(1);
      yield* TestClock.adjust(1);
      expect((yield* page).asks).toEqual([]);
      expect(yield* fs.exists(kept)).toBe(false);
      expect((yield* star.ask({ id: posted.id })).refused).toBe("invalid_request");

      // A thread a link paired below full access started posts and lists its own asks only.
      const linked = server.threads.add(repo.id, "linked", {
        worktreePath: tree,
        activeRunId: RunId.make("linked-run"),
        linkOrigin: { sessionId: "link-1", label: "Laptop", access: "read-only" },
      });
      const fenced = as(linked.shell.id);
      const own = yield* fenced.ask({ text: "From afar" });
      expect((yield* fenced.list()).asks).toMatchObject([{ id: own.id, title: "From afar" }]);
      expect((yield* fenced.list({ star: "vega-id" })).refused).toBe("capability_denied");
      // An outside client is not offered the tools at all.
      const outside = yield* Effect.exit(
        tool("pult_ask_list", scopeOf({ client: "full-access" }), {}),
      );
      expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain("not found");
    }).pipe(
      Effect.scoped,
      // A server's environment, not the process's: an agent's shell carries its desktop app's.
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
);
