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
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

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
import { at, fakeServer, type FakeMessage, run } from "../stars/testing.ts";

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

/** The reply targets the rows read, `AskRows.targetOf`'s spans, which the test's tracer counts. */
let targetReads = 0;
const countingTargets = Tracer.make({
  span: (options) => {
    if (options.name === "AskRows.targetOf") targetReads++;
    return new Tracer.NativeSpan(options);
  },
});

it.effect(
  "threads post, settle and list asks with the pult_ask tools, and the page draws them as rows it acts on and replies to through the extension's handlers",
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
        settle: (id: string, comment?: string) =>
          tool("pult_ask_settle", scopeOf({ thread }), {
            id,
            ...(comment === undefined ? {} : { comment }),
          }),
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
      // The rows as a page follows them (`extensions.subscribeUi`), the last list the asks published.
      const ui = Context.get(context, ExtensionUi.ExtensionUi);
      let published: ReadonlyArray<Record<string, any>> = [];
      // Each list and each send as it lands, for a step whose publish or notice an event or a timer forks.
      const landings = yield* Queue.unbounded<void>();
      yield* Effect.forkScoped(
        Stream.runForEach(ui.published, (list) =>
          Effect.suspend(() => {
            if (list.extension !== "pult" || list.slot !== "shelf-row") return Effect.void;
            published = list.items as typeof published;
            return Queue.offer(landings, undefined);
          }),
        ),
      );
      const sendToThread = server.threads.service.sendToThread;
      server.threads.service.sendToThread = ((input) =>
        sendToThread(input).pipe(
          Effect.tap(() => Queue.offer(landings, undefined)),
        )) as typeof sendToThread;
      /** Once `ready` holds, a publish or a send at a time. */
      const landed = Effect.fn(function* (ready: () => boolean) {
        while (!ready()) yield* Queue.take(landings);
      });
      const rows = Effect.map(
        Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow),
        () => published,
      );
      const rowsWhen = (ready: (list: typeof published) => boolean) =>
        Effect.map(
          landed(() => ready(published)),
          () => published,
        );
      const act = (key: string, action: string, value?: string) =>
        ui
          .act({
            extension: "pult",
            slot: "shelf-row",
            key,
            action,
            ...(value === undefined ? {} : { value }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.message),
            Effect.orElseSucceed(() => "done"),
          );
      const reply = (key: string, text: string, records?: ReadonlyArray<unknown>) =>
        ui.send({
          extension: "pult",
          slot: "shelf-row",
          key,
          message: {
            text,
            ...(records === undefined ? {} : { context: { version: 1, records } as never }),
            attachments: [],
            model: null,
            runtimeMode: null,
            interactionMode: null,
          },
        });
      const commit = (
        type: "thread.settled" | "thread.unsettled" | "thread.archived",
        threadId: string,
      ) =>
        Effect.forEach(server.threads.events.items, ({ queue }) =>
          Queue.offer(queue, {
            type,
            id: `event:${type}:${threadId}`,
            threadId,
            occurredAt: at("2026-11-10T13:00:00.000Z"),
            payload: {},
          } as never),
        );

      // A run the message started ends completed, as upstream commits it; `told` awaits the notice it brings.
      const completed = (message: FakeMessage, told = false) => {
        const before = server.threads.messages.length;
        return Effect.forEach(server.threads.events.items, ({ queue }) =>
          Queue.offer(queue, {
            type: "run.updated",
            id: `event:run:${message.messageId}`,
            threadId: message.threadId,
            occurredAt: at("2026-11-10T13:00:00.000Z"),
            payload: { status: "completed", userMessageId: message.messageId },
          } as never),
        ).pipe(Effect.andThen(told ? landed(() => server.threads.messages.length > before) : rows));
      };
      const unanswered =
        "The turn that received the user's comment on this ask ended with the ask neither answered nor settled, so the user still sees it as being worked on. If the comment needs an answer, call `pult_ask` with its `id` and your answer as `comment`; if nothing is left to ask, settle it with `pult_ask_settle`. Pult tells you once per comment.";

      // An older page reads `asks` gone from `about` as no asks.
      expect((yield* send("GET", "/about")).body.features).not.toContain("asks");

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
            "description": "Ask the user something in Pult: the ask waits in the user's Inbox until they answer or settle it. Its context is a file: name the one that already says what you need with \`file\`, in this thread's worktree or project folder (absolute, or relative to it), or pass \`text\`, Markdown Pult keeps for you; exactly one of them for a new ask. \`title\` defaults to the context's first line. The user answers with a comment on the ask: it comes as a message to this conversation (for a Star, to the channel that asked) opening \`[In reply to your ask <id> "<title>"…]\`, and stays on the ask's page with every other comment, in order, the file \`pult_ask_list\` names as \`page\`. Answer it with \`pult_ask\`, the ask's \`id\` and your answer as \`comment\`: it shows on the page and returns the ask to the user's Inbox; while the user's comment is the last, asking again without a \`comment\` is refused. If the user settles the ask, a message opening \`[From Pult, about your ask <id> "<title>"…]\` tells you so; a settle that crossed your asking again is refused, though its message may still reach you, and the ask stays open as you asked it again. A message opening the same way also tells you, once per comment of the user's, when the turn that received it ended with the ask neither answered nor settled. With the \`id\` of one of your own asks you ask again: it returns to the Inbox, a settled one reopens, and a \`title\` or \`text\` you pass replaces the old, though an ask posted with \`file\` takes no \`text\`: change the file, and say what changed in a \`comment\`. The same \`file\` posted again without an \`id\` is your open ask of that file, asked again. Settle an ask with \`pult_ask_settle\` once it is answered or no longer needed; a settled ask is removed 7 days after its settle, with its page, and its \`id\` is then unknown.",
            "inputSchema": {
              "properties": {
                "comment": {
                  "description": "Your answer to the user's comment, or what changed, shown on the ask's page under the earlier comments; with an \`id\` only.",
                  "type": "string",
                },
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
            "description": "Settle one of your own asks in Pult (for a Star, an ask of any of its channels) once it is answered or no longer needed: it leaves the user's Inbox for Settled, and nobody is told. A \`comment\` closes it on its page, saying how it ended; it is the one comment that does not return the ask to the Inbox. It is removed 7 days after its settle; until then \`pult_ask\` with its \`id\` reopens it.",
            "inputSchema": {
              "properties": {
                "comment": {
                  "description": "A closing comment, shown on the settled ask's page.",
                  "type": "string",
                },
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
            "description": "The asks posted in Pult on this server, by default your own: for a Star, every channel's. Name a Star by \`star\` (its id, with \`channel\` for one of its channels) or a thread by \`thread\` to list theirs. Each row has its \`status\`: \`posted\` (in the user's Inbox), \`replied\` (the user commented last), \`snoozed\` (until \`snoozedUntil\`), or \`settled\` (\`settled\` is when, its thread's settle for a thread's ask while that thread is settled); settled asks are listed only with \`settled: true\`. Each row's \`page\` is the file the user sees, the ask's context with its comments under it: read it for the exchange so far. Work started from a linked environment lists only its own.",
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
                      "page": {
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
                      "page",
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
      const vegaUser = server.threads.add(
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
      // A thread whose folder holds the asks folder.
      const wide = server.threads.add(repo.id, "wide", {
        worktreePath: server.tmp,
        activeRunId: RunId.make("wide-run"),
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
      const starRow = {
        key: posted.id,
        shelf: "inbox",
        title: "Which crate?",
        poster: {
          named: "star-mark",
          star: "vega-id",
          channel: "main",
          fallback: { icon: "account", label: "Star" },
        },
        status: {
          icon: "comment-unresolved",
          label: "Ask",
          time: { at: "2026-11-10T13:00:00.000Z", as: "age" },
        },
        actions: [
          {
            id: "snooze",
            label: "Snooze",
            icon: "clock",
            input: { kind: "instant", label: "Snooze until" },
          },
          { id: "settle", label: "Settle", icon: "check", text: true },
        ],
        open: {
          file: kept,
          reply: {
            // The Star's home, at its open conversation's model.
            target: {
              handled: {
                project: vega.id,
                placeholder: "Write your reply",
                model: expect.objectContaining({ model: expect.any(String) }),
              },
            },
            note: "into its open conversation",
            chips: [
              { label: "serde", text: "serde" },
              { label: "miniserde", text: "miniserde" },
            ],
          },
        },
      };
      // The activation's build had no asks. A post read its new poster's target, and asking again read it again after.
      yield* landed(() => targetReads >= 3);
      expect(targetReads).toBe(3);
      expect(yield* rows).toEqual([
        starRow,
        expect.objectContaining({
          key: filed.id,
          title: "Ship it?",
          poster: { thread: "worker" },
          open: {
            file: `${tree}/notes/q.md`,
            reply: {
              target: { handled: { project: repo.id, placeholder: "Write your reply" } },
              chips: [{ label: "Ship it", text: "Ship it" }],
            },
          },
        }),
      ]);

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
        // A comment answers an ask by its id, and says something within bounds.
        yield* work.ask({ text: "x", comment: "Hello" }),
        yield* work.ask({ id: filed.id, comment: " \n" }),
        yield* work.ask({ id: filed.id, comment: "x".repeat(120001) }),
        yield* work.settle(filed.id, ""),
        // A named file is never one of Pult's pages.
        yield* as(wide.shell.id).ask({ file: `.pult/asks/${posted.id}.md` }),
      ];
      expect(refusals.map((each) => each.refused)).toEqual(
        Array(refusals.length).fill("invalid_request"),
      );
      expect(refusals[5].message).toContain("expired 7 days after its settle");
      expect(refusals.slice(9).map((each) => each.message)).toEqual([
        "A `comment` answers one of your asks: pass its `id`, or ask anew without a `comment`.",
        "`comment` is empty: write your answer, or leave it out.",
        "`comment` is 120001 characters: at most 120000; put the long part in the ask's file or `text`.",
        "`comment` is empty: write your answer, or leave it out.",
        `\`file\` names ${kept}, in Pult's asks folder ${path.dirname(kept)}, where Pult writes the asks' pages: name a file of your own, or pass \`text\`.`,
      ]);
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

      // The rows' actions: snoozed until a time and woken, a reply sent from the row's composer,
      // settled telling the poster, un-settled; what asks do not have refused by name.
      expect(yield* act(posted.id, "wave")).toBe(
        'The item "' + posted.id + '" has no action "wave".',
      );
      expect(yield* act("nobody", "settle")).toContain('no item "nobody"');
      const until = "2026-11-11T09:00:00.000Z";
      const beforeActs = targetReads;
      expect(yield* act(posted.id, "snooze", "2026-11-11T09:00:00Z")).toBe("done");
      expect((yield* rows)[0]).toMatchObject({
        shelf: "snoozed",
        status: { icon: "bell-slash", time: { at: until, as: "clock" } },
        actions: [{ id: "wake" }],
      });
      // An ask from before comments keeps no `text` in its record: its first comment reads it from its file.
      const recordOf = (yield* fs.readDirectory(server.tmp, { recursive: true })).find((each) =>
        each.endsWith(`asks/${posted.id}.json`),
      )!;
      const record = JSON.parse(yield* fs.readFileString(path.join(server.tmp, recordOf)));
      expect(record.text).toBe("# Which crate?\n\nserde or miniserde.");
      delete record.text;
      yield* fs.writeFileString(path.join(server.tmp, recordOf), JSON.stringify(record));
      // A reply goes into the Star's open conversation under the ask's header, as the user's, and moves it to Working, from Snoozed too.
      yield* TestClock.adjust(1000);
      expect(yield* reply(posted.id, "serde")).toEqual({ thread: "vega-user" });
      // A snooze wakes no conversation, so it read no target; a reply may, so it read its Star's again after.
      yield* landed(() => targetReads > beforeActs);
      yield* rows;
      expect(targetReads - beforeActs).toBe(1);
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "vega-user",
        text: "serde",
        header: {
          extension: "pult",
          line: `[In reply to your ask ${posted.id} "Which crate?", to your channel main]`,
          caption: {
            reply: true,
            lead: "Reply to the ask",
            name: "Which crate?",
            open: { row: posted.id },
          },
        },
        createdBy: "user",
        creationSource: "web",
      });
      expect((yield* rows)[0]).toMatchObject({
        shelf: "working",
        status: { icon: "comment", time: { at: "2026-11-10T13:00:02.000Z" } },
        open: { file: kept, reply: { chips: [] } },
      });
      // The reply is the user's comment, on the ask's page under its text.
      expect(yield* fs.readFileString(kept)).toBe(
        "# Which crate?\n\nserde or miniserde.\n\n---\n\n## User, 2026-11-10 13:00 UTC\n\nserde\n",
      );
      expect((yield* star.list()).asks).toMatchObject([{ id: posted.id, page: kept }]);
      // The turn the reply started ends with the ask still replied: the channel is told, once per reply.
      const starReply = server.threads.messages.at(-1)!;
      const beforeRuns = targetReads;
      yield* completed(starReply, true);
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "vega-user",
        text: unanswered,
        header: {
          extension: "pult",
          line: `[From Pult, about your ask ${posted.id} "Which crate?", to your channel main]`,
          caption: { reply: false, lead: "From Pult, about the ask", open: { row: posted.id } },
        },
        createdBy: "agent",
        creationSource: "server",
      });
      const toldUnanswered = server.threads.messages.length;
      yield* completed(starReply);
      expect(server.threads.messages).toHaveLength(toldUnanswered);
      // A Star conversation's first run seen, perhaps a wake's, reads its channel's target again; a later update, nothing.
      yield* landed(() => targetReads > beforeRuns);
      yield* rows;
      expect(targetReads - beforeRuns).toBe(1);
      // Its settle and un-settle each read it again, and the row's composer tells where a reply goes.
      const noteOf = (list: typeof published) =>
        list.find((each) => each.key === posted.id)?.open.reply.note;
      vegaUser.shell = {
        ...vegaUser.shell,
        settledOverride: "settled",
        settledAt: at("2026-11-10T13:00:03.000Z"),
      };
      yield* commit("thread.settled", "vega-user");
      yield* rowsWhen((list) => noteOf(list) === "asleep, wakes in a new conversation");
      vegaUser.shell = { ...vegaUser.shell, settledOverride: null, settledAt: null };
      yield* commit("thread.unsettled", "vega-user");
      yield* rowsWhen((list) => noteOf(list) === "into its open conversation");
      expect(targetReads - beforeRuns).toBe(3);
      yield* act(posted.id, "snooze", until);
      expect(yield* act(posted.id, "wake")).toBe("done");
      expect((yield* rows)[0]).toMatchObject({ shelf: "working" });
      expect(yield* act(posted.id, "settle")).toBe("done");
      expect((yield* rows)[0]).toMatchObject({
        shelf: "settled",
        status: { icon: "check", time: { at: "2026-11-10T13:00:02.000Z" } },
        actions: [{ id: "unsettle" }],
      });
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "vega-user",
        text: "The user settled this ask after commenting on it. `pult_ask` with its id reopens it for 7 days.",
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
      yield* act(posted.id, "settle");
      expect(server.threads.messages).toHaveLength(told);
      expect((yield* star.list()).asks).toEqual([]);
      expect((yield* star.list({ settled: true })).asks).toMatchObject([{ status: "settled" }]);
      expect(yield* act(posted.id, "unsettle")).toBe("done");
      expect((yield* star.list()).asks).toMatchObject([{ status: "replied" }]);
      // A later reply left unanswered is told again; one whose ask is settled as its turn ends is not.
      yield* TestClock.adjust(1000);
      yield* reply(posted.id, "serde, with derive");
      yield* completed(server.threads.messages.at(-1)!, true);
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "vega-user",
        text: unanswered,
      });
      yield* TestClock.adjust(1000);
      yield* reply(posted.id, "Or miniserde");
      const settledReply = server.threads.messages.at(-1)!;
      yield* star.settle(posted.id);
      yield* completed(settledReply);
      expect(server.threads.messages.at(-1)).toBe(settledReply);
      yield* act(posted.id, "unsettle");
      // A plain thread is told in its own thread, here of a settle with no reply.
      // A thread's reply goes into its own thread; its settle is told there, here after that reply.
      // It cites a passage of the ask's file, by its path in the thread's checkout, and one of a message.
      const fileMarker = "[q.md L4](t3-context://v1/review-comment/review-comment_c1)";
      const quoteMarker =
        "[Assistant quote](t3-citation://v1/env-1/worker/message-1?text=All+green.&start=0&end=10&prefix=&suffix=&comment=Even+on+CI%3F)";
      const shipIt = `${fileMarker}\n${quoteMarker}\nShip it`;
      yield* fs.writeFileString(`${tree}/notes/q.md`, "\n## Ship the parser?\n\nIt passes, now.\n");
      expect(
        yield* reply(filed.id, shipIt, [
          {
            version: 1,
            contextId: "review-comment_c1",
            label: "q.md L4",
            kind: "review-comment",
            sectionId: "file:notes/q.md",
            sectionTitle: "File comment",
            filePath: "notes/q.md",
            startIndex: 3,
            endIndex: 3,
            rangeLabel: "L4",
            text: "Since when?",
            diff: "It passes, now.",
            fenceLanguage: "md",
          },
        ]),
      ).toEqual({ thread: "worker" });
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "worker",
        text: shipIt,
        header: { line: `[In reply to your ask ${filed.id} "Ship it?"]` },
        createdBy: "user",
      });
      // A file ask's first comment makes its page, which its row opens from then on: the file a chip
      // on it over its Markdown as it reads now, and each citation where its marker stood, its source
      // over the passage quoted, then the comment on it.
      const filedPage = path.join(path.dirname(kept), `${filed.id}.md`);
      expect(yield* fs.readFileString(filedPage)).toBe(
        [
          `Context: \`${tree}/notes/q.md\``,
          "## Ship the parser?",
          "It passes, now.",
          "---",
          "## User, 2026-11-10 13:00 UTC",
          `> \`${tree}/notes/q.md\` · L4\n>\n> It passes, now.`,
          "Since when?",
          "> A message in the thread\n>\n> All green.",
          "Even on CI?",
          "Ship it\n",
        ].join("\n\n"),
      );
      // The record keeps each citation's source, the quote's thread and message by their ids.
      const filedRecord = JSON.parse(
        yield* fs.readFileString(path.join(server.tmp, recordOf.replace(posted.id, filed.id))),
      );
      expect(
        filedRecord.comments[0].citations.map((each: { source: unknown }) => each.source),
      ).toEqual([
        { file: `${tree}/notes/q.md`, lines: "L4", language: "md" },
        { thread: "worker", message: "message-1" },
      ]);
      expect((yield* rows).find((each) => each.key === filed.id)).toMatchObject({
        open: { file: filedPage },
      });
      expect((yield* work.list()).asks).toMatchObject([
        { id: filed.id, file: `${tree}/notes/q.md`, page: filedPage },
      ]);
      // The same file posted again is asked again, so it too must answer the user.
      expect((yield* work.ask({ file: "notes/q.md" })).message).toContain(
        `The user commented last on the ask "${filed.id}"`,
      );
      const threadReply = server.threads.messages.at(-1)!;
      yield* completed(threadReply, true);
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "worker",
        text: unanswered,
        header: { line: `[From Pult, about your ask ${filed.id} "Ship it?"]` },
      });
      yield* act(filed.id, "settle");
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "worker",
        text: "The user settled this ask after commenting on it. `pult_ask` with its id reopens it for 7 days.",
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
      // Two later replies, the thread's reply, the notices of the turns and the thread's settle, and nothing more.
      expect(server.threads.messages).toHaveLength(told + 6);
      expect((yield* work.settle(posted.id)).refused).toBe("invalid_request");
      // The user commented last, so asking again must answer them.
      expect(yield* star.ask({ id: posted.id, text: "# Which crate, now?" })).toMatchObject({
        refused: "invalid_request",
        message: `The user commented last on the ask "${posted.id}": answer with \`pult_ask\`, its \`id\` and your answer as \`comment\`, or settle it with \`pult_ask_settle\`.`,
      });
      // The poster's comment is an asking again: back to Inbox with its chips, on the page under the user's.
      yield* TestClock.adjust(60_000);
      expect(
        yield* star.ask({
          id: posted.id,
          text: "# Which crate, now?",
          comment: "Both are fine. Derive or not?",
          replies: ["Derive"],
        }),
      ).toEqual(posted);
      expect((yield* star.list()).asks).toMatchObject([
        {
          id: posted.id,
          title: "Which crate, now?",
          status: "posted",
          replied: null,
          replies: ["Derive"],
        },
      ]);
      expect((yield* rows).find((each) => each.key === posted.id)).toMatchObject({
        shelf: "inbox",
        status: { time: { at: "2026-11-10T13:01:04.000Z" } },
        open: { file: kept, reply: { chips: [{ label: "Derive", text: "Derive" }] } },
      });
      expect(yield* fs.readFileString(kept)).toBe(
        [
          "# Which crate, now?",
          "---",
          "## User, 2026-11-10 13:00 UTC\n\nserde",
          "## User, 2026-11-10 13:00 UTC\n\nserde, with derive",
          "## User, 2026-11-10 13:00 UTC\n\nOr miniserde",
          "## Agent, 2026-11-10 13:01 UTC\n\nBoth are fine. Derive or not?\n",
        ].join("\n\n"),
      );
      expect(server.threads.messages).toHaveLength(told + 6);

      // A plain thread's asks follow it: settled while it is, gone once archived, each told by its event.
      expect(yield* act(filed.id, "unsettle")).toBe("done");
      // A settle that crosses its poster asking again, as Pult tells the poster, settles nothing.
      expect(yield* work.ask({ id: filed.id, comment: "Shipped. Tag it too?" })).toEqual(filed);
      // Asked again with no comment, its page shows the file as it reads then.
      yield* fs.writeFileString(`${tree}/notes/q.md`, "## Ship the parser?\n\nShipped.\n");
      const sendOnce = server.threads.service.sendToThread;
      server.threads.service.sendToThread = ((input) => {
        server.threads.service.sendToThread = sendOnce;
        return TestClock.adjust(1000).pipe(
          Effect.andThen(work.ask({ id: filed.id })),
          Effect.andThen(sendOnce(input)),
        );
      }) as typeof sendOnce;
      expect(yield* act(filed.id, "settle")).toBe(
        "The ask was asked again as you settled it, so it is not settled: settle it again if you mean the ask as asked now.",
      );
      expect((yield* work.list()).asks).toMatchObject([{ id: filed.id, status: "posted" }]);
      expect(yield* fs.readFileString(filedPage)).toContain("\n\nShipped.\n\n---\n\n");
      worker.shell = {
        ...worker.shell,
        settledOverride: "settled",
        settledAt: at("2026-11-10T12:30:00.000Z"),
      };
      yield* commit("thread.settled", "worker");
      expect(
        (yield* rowsWhen((list) =>
          list.some((each) => each.key === filed.id && each.shelf === "settled"),
        )).find((each) => each.key === filed.id),
      ).toMatchObject({
        shelf: "settled",
        status: { time: { at: "2026-11-10T12:30:00.000Z" } },
      });
      expect(yield* act(filed.id, "unsettle")).toBe(
        "The ask reads as settled because its thread is: un-settle the thread.",
      );
      worker.shell = { ...worker.shell, archivedAt: at("2026-11-10T12:40:00.000Z") };
      yield* commit("thread.archived", "worker");
      expect(
        (yield* rowsWhen((list) => list.every((each) => each.key !== filed.id))).map(
          (each) => each.key,
        ),
      ).toEqual([posted.id]);
      expect(yield* fs.exists(`${tree}/notes/q.md`)).toBe(true);

      // The file ask's page goes with it; the poster's file stays.
      expect(yield* fs.exists(filedPage)).toBe(false);

      // A closing comment settles it on its page, telling nobody; a settled ask takes none.
      const beforeClosing = server.threads.messages.length;
      expect(yield* star.settle(posted.id, "Going with serde and derive.")).toEqual({
        id: posted.id,
        status: "settled",
      });
      expect(yield* fs.readFileString(kept)).toMatch(
        /## Agent, 2026-11-10 13:01 UTC\n\nBoth are fine\. Derive or not\?\n\n## Agent, settling, 2026-11-10 13:01 UTC\n\nGoing with serde and derive\.\n$/,
      );
      expect((yield* rows).find((each) => each.key === posted.id)).toMatchObject({
        shelf: "settled",
      });
      expect(server.threads.messages).toHaveLength(beforeClosing);
      expect((yield* star.settle(posted.id, "Again")).message).toContain("already settled");
      // A settled ask goes 7 days after its settle, with its page, and its id is then unknown.
      // Its row goes then too, republished at the expiry with no write.
      yield* TestClock.adjust(7 * DAY - 1);
      expect(yield* rows).toHaveLength(1);
      yield* TestClock.adjust(1001);
      expect(yield* rowsWhen((list) => list.length === 0)).toEqual([]);
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
      // A rebuild, here at its poster's event, reads each poster's target once, however many asks it posted.
      const beforeAgain = targetReads;
      yield* fenced.ask({ text: "From afar, again" });
      yield* landed(() => targetReads > beforeAgain);
      yield* rows;
      const beforeRebuild = targetReads;
      yield* commit("thread.unsettled", linked.shell.id);
      yield* landed(() => targetReads > beforeRebuild);
      expect(yield* rows).toHaveLength(2);
      expect(targetReads - beforeRebuild).toBe(1);
      // An outside client is not offered the tools at all.
      const outside = yield* Effect.exit(
        tool("pult_ask_list", scopeOf({ client: "full-access" }), {}),
      );
      expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain("not found");
    }).pipe(
      Effect.scoped,
      Effect.withTracer(countingTargets),
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
