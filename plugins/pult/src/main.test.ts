import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import * as HttpRouter from "effect/http/HttpRouter";
import * as TestClock from "effect/testing/TestClock";

// The real loader, its bundled list and its routes, which the plugin itself never imports.
import * as EnvironmentAuth from "../../../apps/server/src/auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../../../apps/server/src/mcp/McpHttpServer.ts";
import { bundledPlugins } from "../../../apps/server/src/plugins/bundled.ts";
import * as PluginsHttp from "../../../apps/server/src/plugins/http.ts";
import * as PluginLoader from "../../../apps/server/src/plugins/PluginLoader.ts";
import {
  Context,
  Effect,
  FileSystem,
  HttpServerRequest,
  Layer,
  McpInvocationContext,
  McpSchema,
  McpServer,
  Path,
  ServerConfig,
} from "./host.ts";
import * as Stars from "./stars/stars.ts";
import { at, fakeServer, run } from "./stars/testing.ts";

const SESSIONS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": [AuthOrchestrationReadScope],
  "Bearer writer": [AuthOrchestrationReadScope, AuthAccessWriteScope],
};

// A page's session holds both scopes; an agent's MCP session never holds the write one.
const environmentAuth = {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const scopes = SESSIONS[request.headers.authorization ?? ""];
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "unknown" }))
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-1"),
          subject: "test",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

it.effect("the server activates the plugin, which lists stars in about and serves the Stars", () =>
  Effect.gen(function* () {
    const server = yield* fakeServer;
    const loader = Context.get(
      yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provide(Layer.mergeAll(server.layer, McpServer.McpServer.layer)),
        ),
      ),
      PluginLoader.PluginLoader,
    );
    const [status] = (yield* loader.list).filter((plugin) => plugin.name === "pult");
    expect(status).toMatchObject({ build: "bundled", status: "loaded", error: undefined });

    const web = HttpRouter.toWebHandler(
      PluginsHttp.layerRoutes(loader).pipe(
        Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, environmentAuth)),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
    const send = (method: string, path: string, session: "reader" | "writer", body?: unknown) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(`http://127.0.0.1/api/plugins/pult${path}`, {
            method,
            headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const text = await response.text();
        return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
      });

    expect(yield* send("GET", "/about", "reader")).toEqual({
      status: 200,
      body: {
        features: [
          "stars",
          "star-messages",
          "star-sleep-request",
          "star-sleep",
          "star-asks",
          "star-schedules",
        ],
      },
    });
    expect(yield* send("GET", "/stars", "reader")).toEqual({
      status: 200,
      body: { directory: server.directory, hidden: [], stars: [] },
    });

    // The write routes need the scope an agent's session never holds.
    for (const [method, path] of [
      ["POST", "/stars"],
      ["POST", "/stars/upkeep"],
      ["POST", "/stars/any"],
    ] as const)
      expect((yield* send(method, path, "reader", {})).status).toBe(403);

    const created = yield* send("POST", "/stars", "writer", { ifNone: true });
    expect(created.status).toBe(200);
    const star = created.body as { id: string; root: string; projectId: string };
    expect(star.root).toBe((yield* Path.Path).join(server.directory, "star"));
    expect((yield* send("POST", "/stars", "writer", { ifNone: true })).body.id).toBe(star.id);

    const view = yield* send("GET", "/stars", "reader");
    expect(view.body).toMatchObject({
      hidden: [star.projectId],
      stars: [
        {
          id: star.id,
          instructions: `${star.root}/instructions.md`,
          conversation: null,
          work: null,
          conversations: [],
        },
      ],
    });
    expect(view.body.stars[0].asleepSince).toBe(view.body.stars[0].created);
    expect(view.body.stars[0].schedules).toEqual([]);

    // Each Star carries its schedules, read as the page asks; a server under schedules-off fires none.
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${star.root}/.pult/schedules`, { recursive: true });
    yield* fs.writeFileString(
      `${star.root}/.pult/schedules/standup.md`,
      '---\ntimezone: UTC\ntime: "09:00"\ndays: [mon, tue, wed, thu, fri]\n---\nStandup.\n',
    );
    expect((yield* send("GET", "/stars", "reader")).body.stars[0].schedules).toMatchObject([
      {
        name: "standup",
        path: `${star.root}/.pult/schedules/standup.md`,
        rule: "weekdays 09:00",
        timezone: "UTC",
        spent: false,
        problem: null,
        last: null,
      },
    ]);
    const { stateDir } = yield* ServerConfig.ServerConfig.pipe(Effect.provide(server.layer));
    yield* fs.makeDirectory(`${stateDir}/plugins/pult`, { recursive: true });
    yield* fs.writeFileString(`${stateDir}/plugins/pult/schedules-off`, "");
    expect((yield* send("GET", "/about", "reader")).body.features).not.toContain("star-schedules");

    expect(yield* send("POST", `/stars/${star.id}`, "writer", { name: "Vega" })).toMatchObject({
      status: 200,
      body: { id: star.id, name: "Vega" },
    });
    expect(yield* send("POST", "/stars/nobody", "writer", { name: "Vega" })).toMatchObject({
      status: 404,
    });
    expect((yield* send("POST", `/stars/${star.id}`, "writer", { name: 7 })).status).toBe(400);

    // Refresh Context needs the write scope, and refuses a Star asleep already.
    expect((yield* send("POST", `/stars/${star.id}/sleep`, "reader", {})).status).toBe(403);
    expect((yield* send("POST", `/stars/${star.id}/sleep`, "writer", {})).status).toBe(409);
    expect((yield* send("POST", "/stars/nobody/sleep", "writer", {})).status).toBe(404);

    // A transcript the folder holds, parsed; an unknown one or an unknown Star is a 404.
    const name = "2026-11-10T12-00-00Z-thread-1.md";
    const file = `${star.root}/.pult/conversations/env-1/${name}`;
    yield* fs.makeDirectory(`${star.root}/.pult/conversations/env-1`, { recursive: true });
    yield* fs.writeFileString(
      file,
      '---\nthread: "thread-1"\nstarted: "a"\nended: "b"\nenvironment: "MacBook"\ntitle: "t"\nturns: 1\n---\n\n### User · 2026-11-10T12:00:00Z\n\nHello\n',
    );
    expect(yield* send("GET", `/stars/${star.id}/conversations/${name}`, "reader")).toEqual({
      status: 200,
      body: {
        threadId: "thread-1",
        started: "a",
        ended: "b",
        environment: "MacBook",
        title: "t",
        partial: false,
        entries: [{ kind: "user", at: "2026-11-10T12:00:00Z", text: "Hello" }],
      },
    });
    expect((yield* send("GET", `/stars/${star.id}/conversations/notes.md`, "reader")).status).toBe(
      404,
    );
    expect((yield* send("GET", `/stars/nobody/conversations/${name}`, "reader")).status).toBe(404);
    expect((yield* send("POST", "/stars/upkeep", "writer")).body.stars).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

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
  caller: { readonly thread: string } | { readonly client: "read-only" | "full-access" },
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

it.effect(
  "a thread messages a Star with pult_star_message, through the server's access checks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
      const server = yield* fakeServer;
      const context = yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
        ),
      );
      const [status] = (yield* Context.get(context, PluginLoader.PluginLoader).list).filter(
        (plugin) => plugin.name === "pult",
      );
      expect(status).toMatchObject({ status: "loaded", error: undefined });
      const mcp = Context.get(context, McpServer.McpServer);
      const call = (
        scope: McpInvocationContext.McpInvocationScope,
        args: Record<string, unknown>,
      ) =>
        mcp.callTool({ name: "pult_star_message", arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.map((result) => {
            const text = result.content[0];
            return {
              isError: result.isError === true,
              body: text?.type === "text" ? JSON.parse(text.text) : undefined,
            };
          }),
        );

      // The Star, asleep since its first conversation ended; a worker in a repository's project, mid-run.
      const created = yield* server.projects.service.create({
        projectId: ProjectId.make("p-repo"),
        title: "Repo",
        workspaceRoot: `${server.tmp}/repo`,
        createWorkspaceRootIfMissing: true,
      });
      const worker = server.threads.add(created.id, "worker", {
        title: "Worker",
        runtimeMode: "full-access",
        activeRunId: RunId.make("worker-run"),
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(server.directory, "star");
      yield* fs.makeDirectory(path.join(root, ".pult"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".pult/star.yaml"),
        'xaxis-kind: star\nid: "vega-id"\nname: "Vega"\ntint: "amber"\ncreated: "2026-11-10T09:00:00.000Z"\n',
      );
      const starProject = yield* server.projects.service.create({
        projectId: ProjectId.make("p-star"),
        title: "Vega",
        workspaceRoot: root,
      });
      const own = server.threads.add(starProject.id, "star-thread", {
        createdAt: at("2026-11-10T11:00:00.000Z"),
        settledOverride: "settled",
        settledAt: at("2026-11-10T12:00:00.000Z"),
        runtimeMode: "auto",
        activeRunId: RunId.make("star-run"),
      });

      expect(
        yield* call(scopeOf({ thread: "worker" }), { star: "vega-id", message: "Done." }),
      ).toEqual({
        isError: false,
        body: {
          star: { id: "vega-id", name: "Vega" },
          outcome: "launched",
          threadId: "launched-1",
          link: expect.stringContaining("launched-1"),
        },
      });
      expect(server.threads.messages[0]).toMatchObject({
        text: '[From thread worker "Worker" in project "Repo", to your work conversation]\n\nDone.',
        senderThreadId: "worker",
        creationSource: "mcp",
        // The wrapper's limits, the caller's own modes.
        limit: { runtimeMode: "full-access", interactionMode: "default" },
      });
      // The same request again delivers nothing new.
      const again = { star: "vega-id", message: "Done.", clientRequestId: "r1" };
      expect((yield* call(scopeOf({ thread: "worker" }), again)).body.outcome).toBe("queued");
      expect((yield* call(scopeOf({ thread: "worker" }), again)).body).toMatchObject({
        outcome: "replayed",
        threadId: null,
      });

      const refusal = (
        scope: McpInvocationContext.McpInvocationScope,
        args: Record<string, unknown>,
      ) => Effect.map(call(scope, args), ({ isError, body }) => (isError ? body.code : undefined));
      const unknown = yield* call(scopeOf({ thread: "worker" }), { star: "nobody", message: "x" });
      expect(unknown).toMatchObject({ isError: true, body: { code: "invalid_request" } });
      expect(unknown.body.message).toContain('"Vega" (vega-id)');
      // The Star's own conversation, a client outside a thread, a read-only client.
      own.shell = { ...own.shell, settledOverride: null, settledAt: null };
      expect(
        yield* refusal(scopeOf({ thread: "star-thread" }), { star: "vega-id", message: "x" }),
      ).toBe("invalid_request");
      expect(
        yield* refusal(scopeOf({ client: "full-access" }), { star: "vega-id", message: "x" }),
      ).toBe("thread_credential_required");
      expect(
        yield* refusal(scopeOf({ client: "read-only" }), { star: "vega-id", message: "x" }),
      ).toBe("capability_denied");
      // A thread a link paired below full access started; one paired with full access is not fenced.
      const linked = server.threads.add(created.id, "linked", {
        runtimeMode: "full-access",
        activeRunId: RunId.make("linked-run"),
        linkOrigin: { sessionId: "link-1", label: "Laptop", access: "read-only" },
      });
      expect(
        yield* call(scopeOf({ thread: linked.shell.id }), { star: "vega-id", message: "x" }),
      ).toMatchObject({
        isError: true,
        body: { code: "capability_denied", message: expect.stringContaining("message a Star") },
      });
      linked.shell = {
        ...linked.shell,
        linkOrigin: { sessionId: "link-1", label: "Laptop", access: "full-access" },
      };
      expect(
        yield* refusal(scopeOf({ thread: linked.shell.id }), { star: "vega-id", message: "x" }),
      ).toBeUndefined();
      // A thread narrower than the Star's conversation.
      worker.shell = { ...worker.shell, runtimeMode: "approval-required" };
      expect(yield* refusal(scopeOf({ thread: "worker" }), { star: "vega-id", message: "x" })).toBe(
        "runtime_mode_escalation_denied",
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("a Star asks to sleep with pult_star_sleep, and any other caller is refused", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
    const server = yield* fakeServer;
    const context = yield* Layer.build(
      PluginLoader.layer(bundledPlugins).pipe(
        Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
      ),
    );
    const mcp = Context.get(context, McpServer.McpServer);
    expect(mcp.tools.map((each) => each.tool.name)).toContain("pult_star_sleep");
    const call = (scope: McpInvocationContext.McpInvocationScope) =>
      mcp.callTool({ name: "pult_star_sleep", arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.map((result) => {
          const text = result.content[0];
          const body = text?.type === "text" ? JSON.parse(text.text) : undefined;
          return result.isError === true ? { refused: body.code, why: body.message } : body;
        }),
      );

    // Made through Stars of the test's own over the same fake server, as a page's POST /stars would.
    const star = yield* (yield* Stars.make.pipe(Effect.provide(server.layer))).create({
      ifNone: true,
    });
    const later = { promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z") };
    const own = server.threads.add(
      star.projectId,
      "star-thread",
      { ...later, createdAt: at("2026-11-10T12:50:00.000Z"), activeRunId: RunId.make("star-run") },
      // The fake's wait answers the run as it is: the turn has completed.
      [run("star-run", "completed")],
    );
    const below = server.threads.add(star.projectId, "below", {
      activeRunId: RunId.make("below-run"),
      lineage: {
        parentThreadId: own.shell.id,
        relationshipToParent: "subagent",
        rootThreadId: own.shell.id,
      },
    });
    const repo = yield* server.projects.service.create({
      projectId: ProjectId.make("p-repo"),
      title: "Repo",
      workspaceRoot: `${server.tmp}/repo`,
      createWorkspaceRootIfMissing: true,
    });
    server.threads.add(repo.id, "worker", { activeRunId: RunId.make("worker-run") });
    // A thread a link paired below full access launched into the Star's project.
    const fenced = server.threads.add(star.projectId, "fenced", {
      ...later,
      createdAt: at("2026-11-10T12:55:00.000Z"),
      activeRunId: RunId.make("fenced-run"),
      linkOrigin: { sessionId: "link-1", label: "Laptop", access: "read-only" },
    });
    // A Star's conversation with no turn on, whose background subagent still holds the credential.
    const idle = server.threads.add(star.projectId, "idle", {
      ...later,
      pendingBackgroundTasks: [
        {
          kind: "subagent",
          taskId: "task-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
    });

    const noStar = {
      refused: "invalid_request",
      why: expect.stringContaining("this thread is none"),
    };
    expect(yield* call(scopeOf({ thread: "worker" }))).toMatchObject(noStar);
    expect(yield* call(scopeOf({ thread: below.shell.id }))).toMatchObject(noStar);
    expect(yield* call(scopeOf({ thread: fenced.shell.id }))).toMatchObject(noStar);
    expect(yield* call(scopeOf({ thread: idle.shell.id }))).toMatchObject({
      refused: "invalid_request",
      why: expect.stringContaining("no turn on"),
    });
    expect(yield* call(scopeOf({ client: "full-access" }))).toMatchObject({
      refused: "thread_credential_required",
    });
    expect(server.threads.settles).toEqual([]);

    expect(yield* call(scopeOf({ thread: own.shell.id }))).toEqual({
      star: { id: star.id, name: "Star" },
      message: expect.stringContaining("falls asleep when this turn ends"),
    });
    // The request's fiber settles the conversation once the turn has ended.
    yield* server.threads.settled(1);
    expect(server.threads.settles).toEqual([own.shell.id]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
