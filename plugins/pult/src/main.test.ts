import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as HttpRouter from "effect/http/HttpRouter";

// The real loader, its bundled list and its routes, which the plugin itself never imports.
import * as EnvironmentAuth from "../../../apps/server/src/auth/EnvironmentAuth.ts";
import { bundledPlugins } from "../../../apps/server/src/plugins/bundled.ts";
import * as PluginsHttp from "../../../apps/server/src/plugins/http.ts";
import * as PluginLoader from "../../../apps/server/src/plugins/PluginLoader.ts";
import { Context, Effect, FileSystem, HttpServerRequest, Layer, McpServer, Path } from "./host.ts";
import { fakeServer } from "./stars/testing.ts";

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
      body: { features: ["stars"] },
    });
    expect(yield* send("GET", "/stars", "reader")).toEqual({
      status: 200,
      body: { directory: server.directory, hidden: [], stars: [] },
    });

    // The write routes need the scope an agent's session never holds.
    for (const [method, path] of [
      ["POST", "/stars"],
      ["POST", "/stars/upkeep"],
      ["PATCH", "/stars/any"],
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
          conversations: [],
        },
      ],
    });
    expect(view.body.stars[0].asleepSince).toBe(view.body.stars[0].created);

    expect(yield* send("PATCH", `/stars/${star.id}`, "writer", { name: "Vega" })).toMatchObject({
      status: 200,
      body: { id: star.id, name: "Vega" },
    });
    expect(yield* send("PATCH", "/stars/nobody", "writer", { name: "Vega" })).toMatchObject({
      status: 404,
    });
    expect((yield* send("PATCH", `/stars/${star.id}`, "writer", { name: 7 })).status).toBe(400);

    // A transcript the folder holds, parsed; an unknown one or an unknown Star is a 404.
    const name = "2026-11-10T12-00-00Z-thread-1.md";
    const file = `${star.root}/.pult/conversations/env-1/${name}`;
    const fs = yield* FileSystem.FileSystem;
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
