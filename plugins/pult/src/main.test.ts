import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

// The real loader and its bundled list, which the plugin itself never imports.
import { bundledPlugins } from "../../../apps/server/src/plugins/bundled.ts";
import * as PluginLoader from "../../../apps/server/src/plugins/PluginLoader.ts";
import {
  Context,
  Effect,
  HttpServerRequest,
  HttpServerResponse,
  Layer,
  McpServer,
  ServerConfig,
} from "./host.ts";

const layerBase = Layer.mergeAll(
  McpServer.McpServer.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-pult-plugin-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("the server activates the plugin as build bundled, and about lists no features", () =>
  Effect.gen(function* () {
    const loader = Context.get(
      yield* Layer.build(PluginLoader.layer(bundledPlugins)),
      PluginLoader.PluginLoader,
    );
    const [status] = (yield* loader.list).filter((plugin) => plugin.name === "pult");
    expect(status).toMatchObject({ build: "bundled", status: "loaded", error: undefined });

    const handler = loader.route("pult");
    if (handler === undefined) throw new Error("the plugin serves no routes");
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/api/plugins/pult/about"),
    );
    const response = HttpServerResponse.toWeb(yield* handler(request, "/about", []));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ features: [] });
  }).pipe(Effect.scoped, Effect.provide(layerBase)),
);
