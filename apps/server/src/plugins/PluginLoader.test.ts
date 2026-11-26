import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  messageHeaderOf,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
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
import * as ExtensionUi from "./ExtensionUi.ts";
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

/** What the fakes recorded: each message sent into a thread, and each project created. */
const recorded = {
  sent: [] as Array<Record<string, unknown>>,
  projects: [] as Array<{ id: string; workspaceRoot: string; archivedAt: string | null }>,
};

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
    hasReceipt: (commandId: string) =>
      Effect.sync(() => recorded.sent.some((each) => each.commandId === commandId)),
    sendToThread: (input: Record<string, unknown>) =>
      Effect.sync(() => {
        recorded.sent.push(input);
        return { message: { attachments: input.attachments } };
      }),
    // A thread created, then one of each event an extension is told of.
    streamDomainEvents: Stream.fromIterable(
      [
        "thread.created",
        "thread.settled",
        "thread.unsettled",
        "thread.archived",
        "thread.deleted",
      ].map((type) => ({ type, threadId: THREAD })),
    ),
  } as unknown as ThreadManagementService["Service"]),
  Layer.succeed(ProjectService, {
    getShell: (projectId: ProjectId) =>
      Effect.succeed(
        projectId === PROJECT ? Option.some({ workspaceRoot: "/work/project" }) : Option.none(),
      ),
    listShells: () => Effect.sync(() => recorded.projects),
    create: (input: { projectId: string; workspaceRoot: string }) =>
      Effect.sync(() => {
        const project = {
          id: input.projectId,
          workspaceRoot: input.workspaceRoot,
          archivedAt: null,
        };
        recorded.projects.push(project);
        return project;
      }),
  } as unknown as ProjectService["Service"]),
);

const layerBase = Layer.mergeAll(
  layerInProcessMcpServer,
  ExtensionUi.layer,
  layerThreads,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-loader-test-" }),
  NodeCrypto.layer,
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
import { ActionRefused, Effect, HostCallError, Schema, SendRefused, Stream, Tool, Toolkit } from ${JSON.stringify(HOST_IMPORT)};
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

/** An extension calling the threads and projects of the contract, its answers recorded as events. */
const THREADS_ACTIVATE = `
  const note = (label, effect) =>
    Effect.matchEffect(effect, {
      onFailure: (error) => Effect.sync(() => events.push(\`\${label} \${error._tag} \${error.call}: \${error.message}\`)),
      onSuccess: (value) => Effect.sync(() => events.push(\`\${label} \${JSON.stringify(value)}\`)),
    });
  yield* note("get", host.threads.get("thread-1"));
  yield* note("get unknown", host.threads.get("nobody"));
  const message = {
    threadId: "thread-1",
    key: "hello",
    header: { line: "[From the extension]", caption: null },
    text: "Hi",
  };
  yield* note("send", host.threads.send(message));
  yield* note("send again", host.threads.send(message));
  yield* note("send empty key", host.threads.send({ ...message, key: "" }));
  yield* note("send broken line", host.threads.send({ ...message, key: "x", header: { line: "a\\nb", caption: null } }));
  yield* note("send unknown", host.threads.send({ ...message, threadId: "nobody" }));
  yield* note("send composed", host.threads.send({
    threadId: "thread-1",
    key: "reply",
    header: { line: "[A reply]", caption: null },
    composed: {
      text: "Yes",
      attachments: [{ type: "image", id: "attachment-1", name: "a.png", mimeType: "image/png", sizeBytes: 3 }],
      model: { instanceId: "codex", model: "picked" },
      runtimeMode: null,
      interactionMode: null,
    },
  }));
  yield* note("events", Effect.map(Stream.runCollect(Stream.take(host.threadEvents, 4)), (events) => Array.from(events)));
  yield* note("create", Effect.map(host.projects.create({ title: "Asks", workspaceRoot: "/work/asks" }), (project) => project.workspaceRoot));
  yield* note("list", Effect.map(host.projects.list(), (projects) => projects.map((project) => project.workspaceRoot)));
`;

it.effect(
  "an extension reads a thread, sends its own message once per key under a header naming it and the user's with its attachments, follows threads' events, and creates and lists projects; an empty key, a header line that breaks and an unknown thread fail the call",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      recorded.sent.length = 0;
      recorded.projects.length = 0;
      yield* writeExtension("alpha", { activate: THREADS_ACTIVATE });
      yield* startLoaderWith({});
      expect(events().slice(1, -1)).toEqual([
        `get ${JSON.stringify({ id: THREAD, projectId: PROJECT, worktreePath: null, settledAt: "2026-11-20T10:00:00.000Z", archivedAt: null, deletedAt: null })}`,
        "get unknown null",
        "send undefined",
        "send again undefined",
        "send empty key HostCallError threads.send: the key is empty",
        expect.stringMatching(
          /^send broken line HostCallError threads\.send: the header does not decode/,
        ),
        'send unknown HostCallError threads.send: there is no thread "nobody"',
        "send composed undefined",
        `events ${JSON.stringify(["settled", "unsettled", "archived", "deleted"].map((_tag) => ({ _tag, threadId: THREAD })))}`,
        'create "/work/asks"',
        'list ["/work/asks"]',
      ]);
      expect(recorded.sent).toHaveLength(2);
      // The user's message, its attachment and picked model carried, the header added to its context.
      expect(recorded.sent[1]).toMatchObject({
        commandId: "alpha:reply",
        text: "Yes",
        attachments: [{ id: "attachment-1" }],
        modelSelection: { model: "picked" },
        createdBy: "user",
        creationSource: "web",
      });
      expect(messageHeaderOf(recorded.sent[1]?.context as never)?.line).toBe("[A reply]");
      expect(recorded.sent[0]).toMatchObject({
        threadId: THREAD,
        commandId: "alpha:hello",
        messageId: "alpha:hello",
        text: "Hi",
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      });
      expect(messageHeaderOf(recorded.sent[0]?.context as never)).toEqual({
        extension: "alpha",
        line: "[From the extension]",
        caption: null,
      });
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

/** An extension publishing one shelf row, its actions moving it, its send handler answering with a thread. */
const UI_ACTIVATE = `
  const row = (shelf) => ({
    key: "a",
    shelf,
    title: "Ship it?",
    poster: { thread: "thread-1" },
    status: { icon: "inbox", label: "Asked" },
    actions: [
      { id: "snooze", label: "Snooze", icon: "clock", input: { kind: "instant", label: "Snooze until" } },
      { id: "settle", label: "Settle", icon: "check", text: true },
    ],
    open: { reply: { target: { handled: { project: "project-1" } }, chips: [{ label: "Yes", text: "Yes" }] } },
  });
  yield* host.ui.publish("shelf-row", [row("inbox")]);
  yield* host.ui.onAction(({ slot, key, action, value }) =>
    action === "settle"
      ? Effect.fail(new ActionRefused({ message: "not now" }))
      : Effect.sync(() => events.push(\`act \${slot} \${key} \${action} \${value}\`)).pipe(
          Effect.andThen(host.ui.publish("shelf-row", [row("snoozed")])),
          Effect.orDie,
        ),
  );
  yield* host.ui.onSend(({ key, message }) =>
    message.text === "no"
      ? Effect.fail(new SendRefused({ message: "not here" }))
      : Effect.sync(() => {
          events.push(\`send \${key} \${JSON.stringify(message)}\`);
          return { thread: "thread-1" };
        }),
  );
  // A second handler, a repeated key, an undecodable item and an unknown slot fail their calls.
  for (const call of [
    host.ui.onSend(() => Effect.succeed({ thread: "x" })),
    host.ui.publish("shelf-row", [row("inbox"), row("inbox")]),
    host.ui.publish("shelf-row", [{ key: "x" }]),
    host.ui.publish("nowhere", []),
  ]) {
    const error = yield* Effect.flip(call);
    events.push(\`\${error instanceof HostCallError} \${error.call}: \${error.message.split(":")[1].trim()}\`);
  }
`;

it.effect(
  "an extension's published items are state the page follows; an action and a handled send reach its handlers, each unknown name refused, and the items go with its activation",
  () =>
    Effect.gen(function* () {
      events().length = 0;
      yield* writeExtension("alpha", { activate: UI_ACTIVATE });
      const ui = yield* ExtensionUi.ExtensionUi;
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(PluginLoader.layer({}), scope);
      expect(events().slice(1, 5)).toEqual([
        "true ui.onSend: it has a handler already, one per activation",
        'true ui.publish: the key "a" repeats in "shelf-row"',
        'true ui.publish: an item of "shelf-row" does not decode',
        'true ui.publish: there is no slot "nowhere"',
      ]);

      // A subscriber gets the whole set, then each change: the action's own publish, then the list gone.
      const following = yield* ui.published.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const until = "2026-11-27T09:00:00.000Z";
      yield* ui.act({
        extension: "alpha",
        slot: "shelf-row",
        key: "a",
        action: "snooze",
        value: until,
      });
      expect(events()).toContain(`act shelf-row a snooze ${until}`);
      const message = {
        text: "Ship it",
        attachments: [
          {
            type: "image" as const,
            id: "upload-1",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        model: null,
        runtimeMode: null,
        interactionMode: null,
      };
      expect(yield* ui.send({ extension: "alpha", slot: "shelf-row", key: "a", message })).toEqual({
        thread: "thread-1",
      });
      expect(events()).toContain(`send a ${JSON.stringify(message)}`);

      const refusal = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
        Effect.map(Effect.flip(effect), (error) => error.message);
      const act = (fields: Partial<Parameters<typeof ui.act>[0]>) =>
        refusal(
          ui.act({
            extension: "alpha",
            slot: "shelf-row",
            key: "a",
            action: "snooze",
            value: until,
            ...fields,
          }),
        );
      expect([
        yield* act({ extension: "beta" }),
        yield* act({ slot: "nowhere" }),
        yield* act({ key: "b" }),
        yield* act({ action: "wake" }),
        yield* act({ value: undefined }),
        yield* act({ value: "soon" }),
        yield* act({ action: "settle" }),
        yield* act({ action: "settle", value: undefined }),
        yield* refusal(
          ui.send({
            extension: "alpha",
            slot: "shelf-row",
            key: "a",
            message: { ...message, text: "no" },
          }),
        ),
      ]).toEqual([
        'The extension "beta" has nothing in the slot "shelf-row".',
        'There is no slot "nowhere".',
        'The extension "alpha" has no item "b" in "shelf-row".',
        'The item "a" has no action "wake".',
        'The action "snooze" needs a value.',
        'The action "snooze" needs an ISO 8601 time.',
        'The action "settle" takes no value.',
        "not now",
        "not here",
      ]);

      yield* Scope.close(scope, Exit.void);
      const seen = [...(yield* Fiber.join(following))].map(({ extension, slot, items }) => ({
        extension,
        slot,
        shelves: items.map((item) => (item as { shelf: string }).shelf),
      }));
      expect(seen).toEqual([
        { extension: "alpha", slot: "shelf-row", shelves: ["inbox"] },
        { extension: "alpha", slot: "shelf-row", shelves: ["snoozed"] },
        { extension: "alpha", slot: "shelf-row", shelves: [] },
      ]);
      // Gone with its activation: its handlers too.
      expect(yield* act({})).toBe('The extension "alpha" has nothing in the slot "shelf-row".');
    }).pipe(Effect.scoped, Effect.provide(layerBase)),
);

it("the extension entry exports the contract and the Effect namespaces, and nothing else", async () => {
  // Taking a name off, or adding one, is a change to what every extension may use.
  expect(Object.keys(await import("../extensionHost.ts")).toSorted()).toEqual([
    "ActionRefused",
    "CONTRACT",
    "DateTime",
    "Effect",
    "FileSystem",
    "HostCallError",
    "Manifest",
    "Path",
    "Project",
    "Schema",
    "Semaphore",
    "SendRefused",
    "Stream",
    "Thread",
    "Tool",
    "ToolAccess",
    "ToolCaller",
    "Toolkit",
  ]);
});
