/**
 * Pult's plugin, compiled into the server and activated at startup
 * (docs/internals/plugins.md, Bundled plugins). Its routes are the one
 * `host.serve` dispatch below.
 */
import { Effect, HttpServerResponse, type PluginHost } from "./host.ts";
import { starsRoute } from "./stars/routes.ts";
import * as Stars from "./stars/stars.ts";

/**
 * What this build does, one name per feature the page relies on; the page
 * reads it on each connect, and anything but this JSON means no plugin.
 */
const features: ReadonlyArray<string> = ["stars"];

export const activate = Effect.fn("PultPlugin.activate")(function* (host: PluginHost) {
  const stars = yield* Stars.make;
  yield* host.serve((request, path) => {
    if (request.method === "GET" && path === "/about")
      return Effect.succeed(HttpServerResponse.jsonUnsafe({ features }));
    return (
      starsRoute(stars, request, path) ?? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    );
  });
});
