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
  type ServerProvider,
  type ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as TestClock from "effect/testing/TestClock";

// The real runtime, loader, bundled list and routes, which the plugin itself never imports.
import * as AnalyticsService from "../../../apps/server/src/telemetry/AnalyticsService.ts";
import * as CheckpointStore from "../../../apps/server/src/checkpointing/CheckpointStore.ts";
import * as DeviceService from "../../../apps/server/src/device/DeviceService.ts";
import * as DocumentText from "../../../apps/server/src/provider/DocumentText.ts";
import * as ManagedEndpoint from "../../../apps/server/src/cloud/ManagedEndpointRuntime.ts";
import * as GitVcsDriver from "../../../apps/server/src/vcs/GitVcsDriver.ts";
import * as GitWorkflow from "../../../apps/server/src/git/GitWorkflowService.ts";
import * as ManagedPolicy from "../../../apps/server/src/policy/ManagedPolicy.ts";
import * as McpSessions from "../../../apps/server/src/mcp/McpSessionRegistry.testkit.ts";
import * as ModelManifest from "../../../apps/server/src/provider/ModelManifest.ts";
import * as PreviewManager from "../../../apps/server/src/preview/Manager.ts";
import * as ProjectCloneTracker from "../../../apps/server/src/project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../../../apps/server/src/project/ProjectEnrichmentService.ts";
import * as ProjectStore from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../../../apps/server/src/provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../../apps/server/src/provider/ProviderRegistry.ts";
import * as SecretResolver from "../../../apps/server/src/secrets/SecretResolver.ts";
import * as ServerSecretStore from "../../../apps/server/src/auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../../../apps/server/src/sourceControl/SourceControlProviderRegistry.ts";
import * as TaskFolders from "../../../apps/server/src/workspace/TaskFolders.ts";
import * as TerminalManager from "../../../apps/server/src/terminal/Manager.ts";
import * as TextGeneration from "../../../apps/server/src/textGeneration/TextGeneration.ts";
import * as VcsStatusBroadcaster from "../../../apps/server/src/vcs/VcsStatusBroadcaster.ts";
import * as WorkflowForge from "../../../apps/server/src/workflows/WorkflowForge.ts";
import * as WorkspacePaths from "../../../apps/server/src/workspace/WorkspacePaths.ts";
import * as WorktreeSetupTracker from "../../../apps/server/src/project/WorktreeSetupTracker.ts";
import * as XaxisVcsDriver from "../../../apps/server/src/vcs/XaxisVcsDriver.ts";
import * as McpProviderSessions from "../../../packages/provider-core/src/server/McpProviderSessions.ts";
import * as RuntimeLayer from "../../../apps/server/src/orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as ServerActivation from "../../../apps/server/src/serverActivation.ts";
import * as EnvironmentAuth from "../../../apps/server/src/auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../../../apps/server/src/mcp/McpHttpServer.ts";
import { bundledPlugins } from "../../../apps/server/src/plugins/bundled.ts";
import * as PluginsHttp from "../../../apps/server/src/plugins/http.ts";
import * as PluginLoader from "../../../apps/server/src/plugins/PluginLoader.ts";
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  HostProcess,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
  McpInvocationContext,
  McpSchema,
  McpServer,
  Path,
  ServerConfig,
  ServerEnvironment,
  ServerRuntimeStartup,
  UsageLimitSources,
  WorkspaceEntries,
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

it.effect("the plugin activates over the production orchestration services", () =>
  Effect.gen(function* () {
    const server = yield* fakeServer;
    // Fake orchestration services must not mask missing exports from the runtime.
    const platform = Layer.effectContext(
      Layer.build(server.layer).pipe(
        Effect.map(
          Context.pick(
            ServerConfig.ServerConfig,
            ServerEnvironment.ServerEnvironment,
            ServerRuntimeStartup.ServerRuntimeStartup,
            WorkspaceEntries.WorkspaceEntries,
            // Not the runtime's: the server provides them beside it, as it does the platform.
            ProviderRegistry.ProviderRegistry,
            UsageLimitSources.UsageLimitSources,
          ),
        ),
      ),
    );
    const runtime = RuntimeLayer.layerProduction.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AnalyticsService.AnalyticsService)({}),
          Layer.mock(CheckpointStore.CheckpointStore)({}),
          Layer.mock(DeviceService.DeviceService)({}),
          Layer.mock(DocumentText.DocumentText)({}),
          Layer.mock(ManagedEndpoint.CloudManagedEndpointRuntime)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(GitWorkflow.GitWorkflowService)({}),
          FetchHttpClient.layer,
          ManagedPolicy.layerTest(),
          McpSessions.layer,
          McpProviderSessions.layer,
          Layer.mock(ModelManifest.ModelManifest)({}),
          Layer.mock(PreviewManager.PreviewManager)({}),
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
          Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
          ProjectStore.layer,
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          SecretResolver.layer,
          ServerSecretStore.layer,
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused source control link"),
          }),
          Layer.mock(TaskFolders.TaskFolders)({}),
          Layer.mock(TerminalManager.TerminalManager)({}),
          Layer.mock(TextGeneration.TextGeneration)({}),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          Layer.mock(WorkflowForge.WorkflowForge)({
            issues: {} as never,
            pullRequests: {} as never,
          }),
          WorkspacePaths.layer,
          Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
        ),
      ),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(platform),
    );
    const context = yield* Layer.build(runtime);
    const loaderContext = yield* Layer.build(
      PluginLoader.layer(bundledPlugins).pipe(
        Layer.provide(Layer.succeedContext(context)),
        Layer.provide(
          Layer.mergeAll(
            platform,
            McpServer.McpServer.layer,
            // Not the runtime's either: the server's source control layers sit beside it.
            Layer.mock(XaxisVcsDriver.XaxisVcsDriver)({}),
            Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          ),
        ),
      ),
    );
    const loader = Context.get(loaderContext, PluginLoader.PluginLoader);
    expect(yield* loader.list).toContainEqual(
      expect.objectContaining({ name: "pult", status: "loaded", error: undefined }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(ServerActivation.ServerActivation, Effect.never),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.effect("the server activates the plugin, which lists stars in about and serves the Stars", () =>
  Effect.gen(function* () {
    const server = yield* fakeServer;
    const loader = Context.get(
      yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provide(Layer.mergeAll(server.layer, McpServer.McpServer.layer)),
        ),
      ).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
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
          "asks",
          "star-channel-models",
          "star-channel-history",
          "usage-limits",
          "xaxis-kept",
          "keep-awake",
          "star-schedules",
        ],
      },
    });

    // While the server is busy, one caffeinate holds the Mac awake for as long as the server lives.
    const keepAwake = server.runSource("pult-keep-awake");
    const running = () => server.children.map((child) => child.running);
    yield* keepAwake;
    yield* keepAwake;
    expect(server.children).toEqual([
      {
        command: "/usr/bin/caffeinate",
        args: ["-s", "-i", "-w", String(process.pid)],
        running: true,
      },
    ]);
    // One that exits on its own, as to an agent's `pkill caffeinate`, is held again by the next pass.
    server.children[0]!.running = false;
    yield* keepAwake;
    expect(running()).toEqual([false, true]);
    // At rest, it is let go at once.
    server.activity.atRest = true;
    yield* keepAwake;
    expect(running()).toEqual([false, false]);
    // Off, it spawns nothing while busy; the switch is its route's, with the write scope.
    server.activity.atRest = false;
    expect(yield* send("GET", "/keep-awake", "reader")).toEqual({
      status: 200,
      body: { on: true },
    });
    expect((yield* send("POST", "/keep-awake", "reader", { on: false })).status).toBe(403);
    expect((yield* send("POST", "/keep-awake", "writer", { on: "no" })).status).toBe(400);
    expect(yield* send("POST", "/keep-awake", "writer", { on: false })).toEqual({
      status: 200,
      body: { on: false },
    });
    yield* keepAwake;
    expect(running()).toEqual([false, false]);
    expect(yield* send("GET", "/keep-awake", "reader")).toEqual({
      status: 200,
      body: { on: false },
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
          channels: [],
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
    expect(yield* fs.exists(`${stateDir}/plugins/pult/keep-awake-off`)).toBe(true);
    // Activated again, the plugin reads the switch from its file; elsewhere than darwin, `about` names no `keep-awake`.
    const askActivatedOn = (platform: NodeJS.Platform, path: string) =>
      Effect.gen(function* () {
        const again = Context.get(
          yield* Layer.build(
            PluginLoader.layer(bundledPlugins).pipe(
              Layer.provide(Layer.mergeAll(server.layer, McpServer.McpServer.layer)),
            ),
          ).pipe(Effect.provideService(HostProcess.Platform, platform)),
          PluginLoader.PluginLoader,
        );
        const response = yield* again.route("pult")!(
          HttpServerRequest.fromWeb(new Request(`http://127.0.0.1/api/plugins/pult${path}`)),
          path,
          [AuthOrchestrationReadScope],
        );
        const body = yield* Effect.promise(
          () =>
            HttpServerResponse.toWeb(response).json() as Promise<{
              on?: boolean;
              features?: ReadonlyArray<string>;
            }>,
        );
        return body;
      });
    expect(yield* askActivatedOn("darwin", "/keep-awake")).toEqual({ on: false });
    expect((yield* askActivatedOn("linux", "/about")).features).not.toContain("keep-awake");
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

    // The model the page wakes `user` at itself: the Star's choice at the page's mode, none without a file.
    const wake = { runtimeMode: "full-access" };
    expect((yield* send("POST", `/stars/${star.id}/model`, "reader", wake)).status).toBe(403);
    expect((yield* send("POST", `/stars/${star.id}/model`, "writer", {})).status).toBe(400);
    expect(
      (yield* send("POST", `/stars/${star.id}/model`, "writer", { ...wake, channel: "Not A Slug" }))
        .status,
    ).toBe(400);
    expect((yield* send("POST", "/stars/nobody/model", "writer", wake)).status).toBe(404);
    expect(yield* send("POST", `/stars/${star.id}/model`, "writer", wake)).toEqual({
      status: 200,
      body: { model: null },
    });

    // A transcript the folder holds, parsed; an unknown one or an unknown Star is a 404.
    const name = "2026-11-10T12-00-00Z-thread-1.md";
    const file = `${star.root}/.pult/channels/user/conversations/env-1/${name}`;
    yield* fs.makeDirectory(`${star.root}/.pult/channels/user/conversations/env-1`, {
      recursive: true,
    });
    yield* fs.writeFileString(
      file,
      '---\nthread: "thread-1"\nstarted: "a"\nended: "b"\nenvironment: "MacBook"\ntitle: "t"\nturns: 1\n---\n\n### User · 2026-11-10T12:00:00Z\n\nHello\n\n### Star · 2026-11-10T12:00:05Z · messageId="m-1"\n\nHi\n',
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
        entries: [
          { kind: "user", at: "2026-11-10T12:00:00Z", text: "Hello" },
          { kind: "star", at: "2026-11-10T12:00:05Z", text: "Hi", messageId: "m-1" },
        ],
      },
    });
    // A file written before headings named their message reads by name as well, its reply named by none.
    const legacy = "2026-11-09T12-00-00Z-thread-0.md";
    yield* fs.writeFileString(
      `${star.root}/.pult/channels/user/conversations/env-1/${legacy}`,
      '---\nthread: "thread-0"\nstarted: "a"\nended: "b"\nenvironment: "MacBook"\ntitle: "t"\nturns: 0\n---\n\n### Star · 2026-11-09T12:00:05Z\n\nOld\n',
    );
    expect(
      (yield* send("GET", `/stars/${star.id}/conversations/${legacy}`, "reader")).body,
    ).toMatchObject({ entries: [{ kind: "star", at: "2026-11-09T12:00:05Z", text: "Old" }] });
    expect(
      (yield* send("GET", `/stars/${star.id}/conversations/${legacy}`, "reader")).body.entries[0],
    ).not.toHaveProperty("messageId");
    expect((yield* send("GET", `/stars/${star.id}/conversations/notes.md`, "reader")).status).toBe(
      404,
    );
    expect((yield* send("GET", `/stars/nobody/conversations/${name}`, "reader")).status).toBe(404);

    // By its thread: the file whose front matter names it, unopened before, with its name; a
    // name's lossy segment alone, another channel's file or none is a 404, two files a 500.
    const folder = `${star.root}/.pult/channels/user/conversations/env-1`;
    const write = (file: string, thread: string) =>
      fs.writeFileString(
        file,
        `---\nthread: ${JSON.stringify(thread)}\nstarted: "a"\nended: "b"\nenvironment: "MacBook"\ntitle: "t"\nturns: 0\n---\n`,
      );
    const byThread = (thread: string) =>
      send(
        "GET",
        `/stars/${star.id}/conversations/by-thread?threadId=${encodeURIComponent(thread)}`,
        "reader",
      );
    yield* write(`${folder}/2026-11-11T09-00-00Z-thread_2.md`, "thread:2");
    expect(yield* byThread("thread:2")).toMatchObject({
      status: 200,
      body: { name: "2026-11-11T09-00-00Z-thread_2.md", threadId: "thread:2", entries: [] },
    });
    expect((yield* byThread("thread-1")).body).toMatchObject({
      name,
      entries: [{ text: "Hello" }, { text: "Hi", messageId: "m-1" }],
    });
    expect((yield* byThread("thread_2")).status).toBe(404);
    yield* fs.makeDirectory(`${star.root}/.pult/channels/work/conversations/env-1`, {
      recursive: true,
    });
    yield* write(
      `${star.root}/.pult/channels/work/conversations/env-1/2026-11-11T10-00-00Z-thread-3.md`,
      "thread-3",
    );
    const workName = "2026-11-11T10-00-00Z-thread-3.md";
    expect((yield* send("GET", "/stars", "reader")).body.stars[0].histories).toEqual([
      { slug: "work", names: [workName] },
    ]);
    expect(
      (yield* send("GET", `/stars/${star.id}/channels/work/conversations/${workName}`, "reader"))
        .body.threadId,
    ).toBe("thread-3");
    const outside = yield* fs.makeTempDirectoryScoped();
    const outsideFolder = `${outside}/conversations/env-1`;
    yield* fs.makeDirectory(outsideFolder, { recursive: true });
    yield* write(`${outsideFolder}/${name}`, "outside");
    yield* fs.symlink(outside, `${star.root}/.pult/channels/linked`);
    expect((yield* send("GET", "/stars", "reader")).body.stars[0].histories).toEqual([
      { slug: "work", names: [workName] },
    ]);
    yield* fs.symlink(
      `${outsideFolder}/${name}`,
      `${star.root}/.pult/channels/work/conversations/env-1/${name}`,
    );
    for (const slug of ["linked", "work"]) {
      expect(
        (yield* send("GET", `/stars/${star.id}/channels/${slug}/conversations/${name}`, "reader"))
          .status,
      ).toBe(404);
    }
    expect((yield* byThread("thread-3")).status).toBe(404);
    expect((yield* byThread("thread-4")).status).toBe(404);
    expect((yield* send("GET", `/stars/${star.id}/conversations/by-thread`, "reader")).status).toBe(
      400,
    );
    yield* write(`${folder}/2026-11-12T09-00-00Z-thread_2.md`, "thread:2");
    expect((yield* byThread("thread:2")).status).toBe(500);
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
        text: '[From thread worker "Worker" in project "Repo", to your channel work]\n\nDone.',
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
      // The Star's conversation with the user hands something to work, naming no channel.
      own.shell = { ...own.shell, settledOverride: null, settledAt: null };
      expect(
        (yield* call(scopeOf({ thread: "star-thread" }), { star: "vega-id", message: "Build it." }))
          .body,
      ).toMatchObject({ outcome: "queued", threadId: "launched-1" });
      expect(server.threads.messages.at(-1)).toMatchObject({
        threadId: "launched-1",
        text: "[From your channel user, to your channel work]\n\nBuild it.",
        senderThreadId: "star-thread",
      });
      // Its work conversation messaging its own channel is refused nothing: it queues itself a turn.
      const workThread = server.threads.byId(ThreadId.make("launched-1"))!;
      expect(workThread.shell.tags).toEqual(["pult:channel:work"]);
      workThread.shell = { ...workThread.shell, activeRunId: RunId.make("work-run") };
      expect(
        yield* call(scopeOf({ thread: "launched-1" }), { star: "vega-id", message: "Later." }),
      ).toMatchObject({ isError: false, body: { outcome: "queued", threadId: "launched-1" } });
      expect(server.threads.messages.at(-1)?.text).toBe(
        "[From your channel work, to your channel work]\n\nLater.",
      );
      // A client outside a thread, a read-only client.
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

it.effect(
  "pult_star_message lands in the channel the call names, else the caller's tag beside the Star's child tag, else work",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
      const server = yield* fakeServer;
      const context = yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
        ),
      );
      const mcp = Context.get(context, McpServer.McpServer);
      const call = (caller: string, args: Record<string, unknown>) =>
        mcp.callTool({ name: "pult_star_message", arguments: args }).pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            scopeOf({ thread: caller }),
          ),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.map((result) => {
            const text = result.content[0];
            return {
              isError: result.isError === true,
              body: text?.type === "text" ? JSON.parse(text.text) : undefined,
            };
          }),
        );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      /** A Star's folder and project. */
      const starAt = (folder: string, id: string, name: string) =>
        Effect.gen(function* () {
          const root = path.join(server.directory, folder);
          yield* fs.makeDirectory(path.join(root, ".pult"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, ".pult/star.yaml"),
            `xaxis-kind: star\nid: "${id}"\nname: "${name}"\ntint: "amber"\ncreated: "2026-11-10T09:00:00.000Z"\n`,
          );
          return yield* server.projects.service.create({
            projectId: ProjectId.make(`p-${id}`),
            title: name,
            workspaceRoot: root,
          });
        });
      const vega = yield* starAt("star", "vega-id", "Vega");
      const deneb = yield* starAt("star-2", "deneb-id", "Deneb");
      /** An open conversation, idle with its cache warm. */
      const conversation = (projectId: ProjectId, id: string, tags: ReadonlyArray<string>) =>
        server.threads.add(
          projectId,
          id,
          {
            createdAt: at("2026-11-10T12:50:00.000Z"),
            promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z"),
            runtimeMode: "auto",
            tags: [...tags],
          },
          [run(`${id}-run`, "completed")],
        );
      const user = conversation(vega.id, "vega-user", []);
      const work = conversation(vega.id, "vega-work", ["pult:channel:work"]);
      const denebReview = conversation(deneb.id, "deneb-review", ["pult:channel:review"]);
      denebReview.shell = {
        ...denebReview.shell,
        runtimeMode: "full-access",
        activeRunId: RunId.make("deneb-run"),
      };
      const repo = yield* server.projects.service.create({
        projectId: ProjectId.make("p-repo"),
        title: "Repo",
        workspaceRoot: `${server.tmp}/repo`,
        createWorkspaceRootIfMissing: true,
      });
      const child = (id: string, tags: ReadonlyArray<string>) =>
        server.threads.add(repo.id, id, {
          title: id,
          runtimeMode: "full-access",
          activeRunId: RunId.make(`${id}-run`),
          tags: [...tags],
        });
      child("builder", ["pult:child:star:vega-id", "pult:channel:unit-2"]);
      child("untagged", ["pult:child:star:vega-id"]);
      child("foreign", ["pult:child:star:deneb-id", "pult:channel:unit-2"]);
      const landed = () => {
        const message = server.threads.messages.at(-1);
        const thread = message === undefined ? undefined : server.threads.byId(message.threadId);
        return { thread: thread?.shell.id, tags: thread?.shell.tags, text: message?.text };
      };

      // A child tagged for a channel wakes it in a thread of its own, user and work untouched.
      expect((yield* call("builder", { star: "vega-id", message: "Done." })).body.outcome).toBe(
        "launched",
      );
      expect(landed()).toEqual({
        thread: "launched-1",
        tags: ["pult:channel:unit-2"],
        text: '[From thread builder "builder" in project "Repo", to your channel unit-2]\n\nDone.',
      });
      expect([user.runs.length, work.runs.length]).toEqual([1, 1]);
      // No channel tag, or another Star's child tag beside one: work.
      yield* call("untagged", { star: "vega-id", message: "Done." });
      expect(landed().thread).toBe(work.shell.id);
      yield* call("foreign", { star: "vega-id", message: "Done." });
      expect(landed().thread).toBe(work.shell.id);
      // The call's channel wins over the tag.
      yield* call("builder", { star: "vega-id", message: "Elsewhere.", channel: "unit-3" });
      expect(landed().tags).toEqual(["pult:channel:unit-3"]);
      // Another Star names a channel, `user` included, and is named with its own.
      yield* call("deneb-review", { star: "vega-id", message: "A question.", channel: "user" });
      expect(landed()).toEqual({
        thread: user.shell.id,
        tags: [],
        text: '[From Star "Deneb" (deneb-id), its channel review, to your channel user]\n\nA question.',
      });
      // A channel that is no slug is invalid parameters, and nothing lands.
      const count = server.threads.messages.length;
      const invalid = yield* Effect.flip(
        call("builder", { star: "vega-id", message: "x", channel: "Unit 2" }),
      );
      expect(invalid).toBeInstanceOf(McpSchema.InvalidParams);
      expect(server.threads.messages.length).toBe(count);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "a Star asks to sleep with pult_star_sleep, and any other caller is refused or not offered it",
  () =>
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
        {
          ...later,
          createdAt: at("2026-11-10T12:50:00.000Z"),
          activeRunId: RunId.make("star-run"),
        },
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
      // A thread-bound tool is not offered to an outside client at all.
      const outside = yield* Effect.exit(call(scopeOf({ client: "full-access" })));
      expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain("not found");
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

it.effect(
  "pult_star_list lists this server's Stars by name, each with its record's description",
  () =>
    Effect.gen(function* () {
      const server = yield* fakeServer;
      const context = yield* Layer.build(
        PluginLoader.layer(bundledPlugins).pipe(
          Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
        ),
      );
      const mcp = Context.get(context, McpServer.McpServer);
      const call = (scope: McpInvocationContext.McpInvocationScope) =>
        mcp.callTool({ name: "pult_star_list", arguments: {} }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.map((result) => {
            const text = result.content[0];
            const body = text?.type === "text" ? JSON.parse(text.text) : undefined;
            return result.isError === true ? { refused: body.code } : body;
          }),
        );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const starAt = (folder: string, id: string, lines: string) =>
        Effect.gen(function* () {
          const root = path.join(server.directory, folder);
          yield* fs.makeDirectory(path.join(root, ".pult"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, ".pult/star.yaml"),
            `xaxis-kind: star\nid: "${id}"\n${lines}tint: "amber"\ncreated: "2026-11-10T09:00:00.000Z"\n`,
          );
          yield* server.projects.service.create({
            projectId: ProjectId.make(`p-${id}`),
            title: id,
            workspaceRoot: root,
          });
        });
      // A record written before the field, with no description line.
      yield* starAt("star", "vega-id", 'name: "Vega"\n');
      yield* starAt("star-2", "deneb-id", 'name: "Deneb"\ndescription: "Lead of the Pult track"\n');
      const repo = yield* server.projects.service.create({
        projectId: ProjectId.make("p-repo"),
        title: "Repo",
        workspaceRoot: `${server.tmp}/repo`,
        createWorkspaceRootIfMissing: true,
      });
      server.threads.add(repo.id, "worker", { activeRunId: RunId.make("worker-run") });
      const fenced = server.threads.add(repo.id, "fenced", {
        activeRunId: RunId.make("fenced-run"),
        linkOrigin: { sessionId: "link-1", label: "Laptop", access: "read-only" },
      });

      expect(yield* call(scopeOf({ thread: "worker" }))).toEqual({
        stars: [
          { id: "deneb-id", name: "Deneb", description: "Lead of the Pult track" },
          { id: "vega-id", name: "Vega", description: "" },
        ],
      });
      // A thread-bound tool is not offered to an outside client at all.
      const outside = yield* Effect.exit(call(scopeOf({ client: "full-access" })));
      expect(Exit.isFailure(outside) && Cause.pretty(outside.cause)).toContain("not found");
      expect(yield* call(scopeOf({ thread: fenced.shell.id }))).toEqual({
        refused: "capability_denied",
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("pult_usage_limits refreshes stale limits, then paces each window on working days", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-16T12:44:00.000Z"));
    const server = yield* fakeServer;
    const provider = (
      instanceId: string,
      driver: string,
      displayName: string,
      email: string,
      usageLimits: ServerProviderUsageLimits,
    ) =>
      ({
        instanceId,
        driver,
        displayName,
        enabled: true,
        installed: true,
        availability: "available",
        auth: { status: "authenticated", email, label: "Max" },
        usageLimits,
      }) as unknown as ServerProvider;
    server.limits.providers = [
      provider("claude", "claudeAgent", "Claude", "a@example.com", {
        checkedAt: "2026-11-16T12:58:00.000Z",
        windows: [
          // Three of five hours gone, 70% spent: more than five points past even pace.
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 70,
            resetsAt: "2026-11-16T15:00:00.000Z",
            windowDurationMins: 300,
          },
          // Nothing spent, still shown.
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 0,
            resetsAt: "2026-11-20T13:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
      provider("codex", "codex", "Codex", "b@example.com", {
        checkedAt: "2026-11-16T12:40:00.000Z",
        windows: [
          // No reset clock: no pace, and the 95% rule alone.
          { id: "primary", kind: "session", label: "Session", usedPercent: 97 },
          {
            id: "secondary",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 30,
            resetsAt: "2026-11-18T13:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
      provider("codex-work", "codex", "Codex Work", "w@example.com", {
        checkedAt: "2026-11-16T12:59:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex could not read its limits." },
      }),
    ];
    server.limits.sources = [
      {
        id: "hub" as never,
        kind: "cliproxy",
        label: "Hub",
        checkedAt: "2026-11-16T12:59:00.000Z",
        accounts: [
          {
            id: "c@example.com.json",
            driver: "claudeAgent" as never,
            email: "c@example.com",
            plan: "Pro",
            usageLimits: {
              checkedAt: "2026-11-16T12:59:00.000Z",
              windows: [
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 50,
                  resetsAt: "2026-11-19T13:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
          },
        ],
      },
      {
        id: "old-hub" as never,
        kind: "cliproxy",
        label: "Old hub",
        checkedAt: "2026-11-16T12:59:00.000Z",
        accounts: [],
        error: "Connection refused.",
      },
    ];
    const context = yield* Layer.build(
      PluginLoader.layer(bundledPlugins).pipe(
        Layer.provideMerge(Layer.mergeAll(server.layer, McpHttpServer.layerInProcessMcpServer)),
      ),
    );
    const mcp = Context.get(context, McpServer.McpServer);
    const read = Effect.gen(function* () {
      const result = yield* mcp.callTool({ name: "pult_usage_limits", arguments: {} }).pipe(
        // A read-only client reads them too.
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          scopeOf({ client: "read-only" }),
        ),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        // The pace counts working days at the server's midnights: Buenos Aires', UTC-3 with no DST.
        Effect.provideService(
          DateTime.CurrentTimeZone,
          DateTime.zoneMakeNamedUnsafe("America/Argentina/Buenos_Aires"),
        ),
      );
      const text = result.content[0];
      expect(result.isError).not.toBe(true);
      return text?.type === "text" ? JSON.parse(text.text) : undefined;
    });
    const checkedAt = (answer: { accounts: ReadonlyArray<{ checkedAt: string }> }) =>
      answer.accounts.map((account) => account.checkedAt);
    // Codex was read four minutes ago, the rest later: all fresh, no refresh.
    yield* read;
    expect(server.limits.refreshed).toEqual([]);
    // Codex was read twenty minutes ago: the read refreshes first, once, and answers the new read.
    yield* TestClock.adjust("16 minutes");
    server.limits.onRefresh = () => {
      server.limits.providers = server.limits.providers.map((provider) =>
        provider.instanceId === "codex"
          ? {
              ...provider,
              usageLimits: { ...provider.usageLimits!, checkedAt: "2026-11-16T13:00:00.000Z" },
            }
          : provider,
      );
    };
    expect(yield* read).toEqual({
      now: "2026-11-16T13:00:00.000Z",
      accounts: [
        {
          provider: "claudeAgent",
          displayName: "Claude",
          email: "a@example.com",
          plan: "Max",
          hub: null,
          checkedAt: "2026-11-16T12:58:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              lengthMins: 300,
              usedPercent: 70,
              resetsAt: "2026-11-16T15:00:00.000Z",
              evenPercent: 60,
              warning: true,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              lengthMins: 10080,
              usedPercent: 0,
              resetsAt: "2026-11-20T13:00:00.000Z",
              // Monday 10:00 in Buenos Aires: 24 of the window's 120 working hours gone, not 3 of 7 days.
              evenPercent: 20,
              warning: false,
            },
          ],
        },
        {
          provider: "codex",
          displayName: "Codex",
          email: "b@example.com",
          plan: "Max",
          hub: null,
          checkedAt: "2026-11-16T13:00:00.000Z",
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              lengthMins: null,
              usedPercent: 97,
              resetsAt: null,
              evenPercent: null,
              warning: true,
            },
            {
              id: "secondary",
              kind: "weekly",
              label: "Weekly",
              lengthMins: 10080,
              usedPercent: 30,
              resetsAt: "2026-11-18T13:00:00.000Z",
              evenPercent: 60,
              warning: false,
            },
          ],
        },
        {
          provider: "claudeAgent",
          displayName: null,
          email: "c@example.com",
          plan: "Pro",
          hub: "Hub",
          checkedAt: "2026-11-16T12:59:00.000Z",
          windows: [
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              lengthMins: 10080,
              usedPercent: 50,
              resetsAt: "2026-11-19T13:00:00.000Z",
              // Two of five working days gone: ten points past, though the calendar's 57.1 is not.
              evenPercent: 40,
              warning: true,
            },
          ],
        },
      ],
      // The account whose read failed is no account, only its notice.
      notices: ["Codex Work: Codex could not read its limits.", "Old hub: Connection refused."],
    });
    expect(server.limits.refreshed).toEqual(["providers", "sources"]);
    // Claude's read is now eight minutes old; this refresh reads nothing new, as a failed one keeps the old reads.
    server.limits.onRefresh = () => {};
    yield* TestClock.adjust("6 minutes");
    const stale = [
      "2026-11-16T12:58:00.000Z",
      "2026-11-16T13:00:00.000Z",
      "2026-11-16T12:59:00.000Z",
    ];
    expect(checkedAt(yield* read)).toEqual(stale);
    expect(server.limits.refreshed).toHaveLength(4);
    // Inside five minutes of that attempt, still stale, no second one.
    yield* TestClock.adjust("4 minutes");
    expect(checkedAt(yield* read)).toEqual(stale);
    expect(server.limits.refreshed).toHaveLength(4);
    // Friday 14:40 in Buenos Aires, in a week that reset Tuesday 02:00 UTC: 87h40m of its 120 working
    // hours gone, so 61% spent is on pace, where the calendar's 52.2 would warn.
    yield* TestClock.setTime(Date.parse("2026-11-20T17:40:00.000Z"));
    server.limits.providers = server.limits.providers.map((provider) =>
      provider.instanceId === "claude"
        ? {
            ...provider,
            usageLimits: {
              checkedAt: "2026-11-20T17:39:00.000Z",
              windows: [
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 61,
                  resetsAt: "2026-11-24T02:00:00.000Z",
                  windowDurationMins: 10080,
                },
              ],
            },
          }
        : provider,
    );
    const friday = yield* read;
    expect(friday.accounts[0].windows).toEqual([
      expect.objectContaining({ id: "seven_day", evenPercent: 73.1, warning: false }),
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
