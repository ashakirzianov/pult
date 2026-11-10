/**
 * Pult's plugin, compiled into the server and activated at startup
 * (docs/internals/plugins.md, Bundled plugins). Its routes are the one
 * `host.serve` dispatch below.
 */
import { Effect, HttpServerResponse, type PluginHost } from "./host.ts";

/**
 * What this build does, one name per feature the page relies on; the page
 * reads it on each connect, and anything but this JSON means no plugin.
 */
const features: ReadonlyArray<string> = [];

export const activate = (host: PluginHost) =>
  host.serve((request, path) =>
    Effect.succeed(
      request.method === "GET" && path === "/about"
        ? HttpServerResponse.jsonUnsafe({ features })
        : HttpServerResponse.empty({ status: 404 }),
    ),
  );
