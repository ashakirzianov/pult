import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import effectPackage from "effect/package.json" with { type: "json" };

import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { layerInProcessMcpServer } from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as PluginLoader from "./PluginLoader.ts";

/** Fixture extensions import the entry by path: vitest serves them, not Node's resolver. */
const HOST_IMPORT = new URL("../extensionHost.ts", import.meta.url).href;

declare global {
  var __pluginLoaderTestEvents: Array<string> | undefined;
}

const events = (): Array<string> => (globalThis.__pluginLoaderTestEvents ??= []);

const PROJECT = ProjectId.make("project-1");
const THREAD = ThreadId.make("thread-1");
const PROVIDER = ProviderInstanceId.make("codex");

/** One live thread in a project rooted at `/work/project`, its run on. */
const layerThreads = Layer.mergeAll(
  Layer.succeed(ThreadManagementService, {
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === THREAD
          ? {
              ...v2ThreadShell,
              id: THREAD,
              projectId: PROJECT,
              providerInstanceId: PROVIDER,
              activeRunId: RunId.make("run-1"),
              settledAt: DateTime.makeUnsafe("2026-11-20T10:00:00.000Z"),
            }
          : null,
      ),
  } as unknown as ThreadManagementService["Service"]),
  Layer.succeed(ProjectService, {
    getShell: (projectId: ProjectId) =>
      Effect.succeed(
        projectId === PROJECT ? Option.some({ workspaceRoot: "/work/project" }) : Option.none(),
      ),
  } as unknown as ProjectService["Service"]),
);

const layerBase = Layer.mergeAll(
  layerInProcessMcpServer,
  layerThreads,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-loader-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const scopeOf = (thread: ThreadId | undefined): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session-1",
  thread:
    thread === undefined
      ? undefined
      : { threadId: thread, providerSessionId: "session-1", providerInstanceId: PROVIDER },
  client:
    thread === undefined
      ? { sessionId: "client-1", label: "Client", access: "full-access" }
      : undefined,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "loader-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "loader-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * An extension registering `<name>_whoami`, which answers with its caller, and recording its
 * import, activation and disposal; `activate` replaces its activation's body.
 */
const extensionSource = (name: string, options: { readonly activate?: string } = {}) => `
import { Effect, Schema, Tool, Toolkit } from ${JSON.stringify(HOST_IMPORT)};
const events = globalThis.__pluginLoaderTestEvents;
events.push("import ${name}");
const Whoami = Tool.make("${name}_whoami", {
  description: "Who calls.",
  parameters: Schema.Struct({ greeting: Schema.String }),
  success: Schema.Struct({ greeting: Schema.String, caller: Schema.Unknown, dataDir: Schema.String }),
  failureMode: "return",
});
export const activate = (host) => Effect.gen(function* () {
  ${
    options.activate ??
    `yield* host.tools.register(Toolkit.make(Whoami), {
    ${name}_whoami: {
      access: "acts-as-caller",
      handle: ({ greeting }, caller) => Effect.succeed({ greeting, caller, dataDir: host.dataDir }),
    },
  });`
  }
  events.push("activate ${name}");
  yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("dispose ${name}"); }));
});
`;

const manifestOf = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ version: "0.3.0", contract: 1, effect: effectPackage.version, ...fields });

const pluginsDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "plugins");
});

/** Writes `<home>/plugins/<name>/` with each file given. */
const writeInstalled = (name: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(yield* pluginsDir, name, file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, text);
    }
  });

const writeExtension = (name: string, options: { readonly activate?: string } = {}) =>
  writeInstalled(name, {
    "extension.json": manifestOf(),
    "main.mjs": extensionSource(name, options),
  });

/** Builds the loader, which loads everything at startup, and keeps it alive for the test's scope. */
const startLoaderWith = (bundled: PluginLoader.BundledPlugins) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(PluginLoader.layer(bundled));
    return Context.get(context, PluginLoader.PluginLoader);
  });

const listed = (loader: PluginLoader.PluginLoader["Service"]) =>
  Effect.map(loader.list, (plugins) =>
    plugins.map(({ name, version, kind, status }) => ({ name, version, kind, status })),
  );

/** A bundled plugin serving its name, or failing its activation with `failure`. */
const bundledPlugin =
  (name: string, failure?: string): PluginLoader.BundledPlugins[string] =>
  () =>
    Promise.resolve({
      activate: (host: PluginLoader.PluginHost) =>
        Effect.gen(function* () {
          events().push(`activate ${name}`);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events().push(`dispose ${name}`);
            }),
          );
          if (failure !== undefined) return yield* Effect.fail(failure);
          yield* host.serve((_request, path) =>
            Effect.succeed(HttpServerResponse.text(`${host.name} ${path}`)),
          );
        }),
    });

/** What the plugin's published route answers for `path`. */
const answerOf = (loader: PluginLoader.PluginLoader["Service"], name: string, path: string) =>
  Effect.gen(function* () {
    const handler = loader.route(name);
    if (handler === undefined) return undefined;
    const request = HttpServerRequest.fromWeb(
      new Request(`http://127.0.0.1/api/plugins/${name}${path}`),
    );
    const response = yield* handler(request, path, [AuthOrchestrationReadScope]);
    return yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
  });

const callTool = (name: string, thread: ThreadId | undefined, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const result = yield* mcp
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(thread)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    const text = result.content[0];
    return {
      isError: result.isError === true,
      body: text?.type === "text" ? JSON.parse(text.text) : undefined,
    };
  });

/** Whether the tool's visibility offers it to a call from `thread`, or from an outside client. */
const offered = (name: string, thread: ThreadId | undefined) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const entry = mcp.tools.find((each) => each.tool.name === name);
    const enabledWhen = entry && Context.getOrUndefined(entry.annotations, McpSchema.EnabledWhen);
    if (enabledWhen === undefined) return entry !== undefined;
    return yield* Effect.sync(() =>
      enabledWhen({
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: mcpClient.clientInfo,
      }),
    ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(thread)));
  });

it.effect(
  "startup loads an extension and lists its version; a thread's call reaches its handler with the caller's data, and an outside client is neither offered the tool nor answered",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      yield* writeExtension("alpha");
      const loader = yield* startLoaderWith({});

      expect(yield* listed(loader)).toEqual([
        { name: "alpha", version: "0.3.0", kind: "installed", status: "loaded" },
      ]);
      expect(events()).toEqual(["import alpha", "activate alpha"]);
      expect(loader.route("alpha")).toBeUndefined();

      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const dataDir = `${config.stateDir}/plugins/alpha`;
      expect(yield* fs.exists(dataDir)).toBe(true);
      expect(yield* callTool("alpha_whoami", THREAD, { greeting: "hi" })).toEqual({
        isError: false,
        body: {
          greeting: "hi",
          dataDir,
          caller: {
            thread: {
              id: THREAD,
              projectId: PROJECT,
              worktreePath: null,
              settledAt: "2026-11-20T10:00:00.000Z",
              archivedAt: null,
              deletedAt: null,
            },
            folder: "/work/project",
            fenced: false,
          },
        },
      });
      expect(yield* offered("alpha_whoami", THREAD)).toBe(true);
      expect(yield* offered("alpha_whoami", undefined)).toBe(false);
      // Hidden, the tool is not there for an outside client to call.
      const outside = yield* Effect.flip(callTool("alpha_whoami", undefined, { greeting: "hi" }));
      expect(outside.message).toBe("Tool 'alpha_whoami' not found");
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it.effect(
  "an extension this server does not serve is refused by name before any of its code runs",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      const [major, minor] = effectPackage.version.split(".").map(Number);
      const source = (name: string) => ({ "main.mjs": extensionSource(name) });
      yield* writeInstalled("contract", {
        ...source("contract"),
        "extension.json": manifestOf({ contract: 2 }),
      });
      yield* writeInstalled("major", {
        ...source("major"),
        "extension.json": manifestOf({ effect: `${major! + 1}.0.0` }),
      });
      yield* writeInstalled("newer", {
        ...source("newer"),
        "extension.json": manifestOf({ effect: `${major}.${minor! + 1}.0` }),
      });
      yield* writeInstalled("loose", {
        ...source("loose"),
        "extension.json": manifestOf({ effect: `${major}.${minor}` }),
      });
      yield* writeInstalled("garbled", {
        ...source("garbled"),
        "extension.json": JSON.stringify({ version: 3, contract: 1 }),
      });
      yield* writeInstalled("bare", source("bare"));
      yield* writeInstalled("raw", { "builds/b1/main.mjs": extensionSource("raw") });
      const loader = yield* startLoaderWith({});

      const plugins = yield* loader.list;
      expect(plugins.map(({ name, status }) => ({ name, status }))).toEqual(
        ["bare", "contract", "garbled", "loose", "major", "newer", "raw"].map((name) => ({
          name,
          status: "refused",
        })),
      );
      const errorOf = (name: string) => plugins.find((each) => each.name === name)?.error;
      expect(errorOf("bare")).toContain("it has no extension.json");
      expect(errorOf("contract")).toContain("built against contract 2");
      expect(errorOf("garbled")).toContain("does not decode");
      expect(errorOf("loose")).toContain("is not a version x.y.z");
      expect(errorOf("major")).toContain("another major");
      expect(errorOf("newer")).toContain("newer than this server's");
      expect(errorOf("raw")).toContain("retired form");
      // A manifest that decoded lists its version though the extension is refused.
      expect(plugins.find((each) => each.name === "contract")?.version).toBe("0.3.0");
      expect(plugins.find((each) => each.name === "bare")?.version).toBeUndefined();
      expect(events()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it.effect(
  "an extension whose activation fails is closed and listed as failed, and the rest load",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      // A finalizer dying as the failed activation closes leaves the activation's failure reported.
      yield* writeExtension("alpha", {
        activate: `yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("dispose alpha"); }).pipe(Effect.andThen(Effect.die("cleanup broke"))));
  return yield* Effect.fail(new Error("boom"));`,
      });
      // A tool not named `<name>_*` fails the registration.
      yield* writeExtension("beta", {
        activate: `yield* host.tools.register(Toolkit.make(Tool.make("gamma_whoami", {})), {
    gamma_whoami: { access: "reads-as-caller", handle: () => Effect.void },
  });`,
      });
      yield* writeExtension("gamma");
      // Nor one the server already has: `delta` loads first and holds `delta_x_lookup`.
      const lookup = `yield* host.tools.register(Toolkit.make(Tool.make("delta_x_lookup", {})), {
    delta_x_lookup: { access: "reads-as-caller", handle: () => Effect.void },
  });`;
      yield* writeExtension("delta", { activate: lookup });
      yield* writeExtension("delta_x", { activate: lookup });
      const loader = yield* startLoaderWith({});

      const plugins = yield* loader.list;
      expect(plugins.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "alpha", status: "failed" },
        { name: "beta", status: "failed" },
        { name: "delta", status: "loaded" },
        { name: "delta_x", status: "failed" },
        { name: "gamma", status: "loaded" },
      ]);
      expect(plugins[0]?.error).toContain("boom");
      expect(plugins[1]?.error).toContain('"gamma_whoami", which is not named beta_*');
      expect(plugins[3]?.error).toContain('"delta_x_lookup", which the server already has');
      expect(events()).toEqual([
        "import alpha",
        "dispose alpha",
        "import beta",
        "import delta",
        "activate delta",
        "import delta_x",
        "import gamma",
        "activate gamma",
      ]);
      expect(yield* offered("gamma_whoami", THREAD)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it.effect(
  "a bundled plugin activates at startup, lists the server's version, and shadows its installed folder",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      yield* writeExtension("gamma");
      const loader = yield* startLoaderWith({ gamma: bundledPlugin("gamma") });

      expect(yield* listed(loader)).toEqual([
        { name: "gamma", version: packageJson.version, kind: "bundled", status: "loaded" },
      ]);
      expect(events()).toEqual(["activate gamma"]);
      expect(yield* answerOf(loader, "gamma", "/ping")).toBe("gamma /ping");
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it.effect("a bundled plugin that fails to activate is listed as failed and the rest load", () =>
  Effect.gen(function* () {
    events().length = 0;
    yield* writeExtension("alpha");
    const loader = yield* startLoaderWith({ gamma: bundledPlugin("gamma", "boom") });

    const plugins = yield* loader.list;
    expect(plugins.map(({ name, kind, status }) => ({ name, kind, status }))).toEqual([
      { name: "alpha", kind: "installed", status: "loaded" },
      { name: "gamma", kind: "bundled", status: "failed" },
    ]);
    expect(plugins[1]?.error).toContain("boom");
    expect(events()).toEqual(["activate gamma", "dispose gamma", "import alpha", "activate alpha"]);
    expect(loader.route("gamma")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it("the extension entry exports the contract and the Effect namespaces, and nothing else", async () => {
  // Taking a name off, or adding one, is a change to what every extension may use.
  expect(Object.keys(await import("../extensionHost.ts")).toSorted()).toEqual([
    "CONTRACT",
    "Effect",
    "FileSystem",
    "Manifest",
    "Path",
    "Schema",
    "Thread",
    "Tool",
    "ToolAccess",
    "ToolCaller",
    "Toolkit",
  ]);
});
