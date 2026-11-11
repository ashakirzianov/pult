/**
 * Pult's plugin, compiled into the server and activated at startup
 * (docs/internals/plugins.md, Bundled plugins). Its routes are the one
 * `host.serve` dispatch below; its tools register last.
 */
import { Effect, HttpServerResponse, Layer, type PluginHost } from "./host.ts";
import * as Schedules from "./schedules/schedules.ts";
import * as Delivery from "./stars/deliver.ts";
import * as MessageTool from "./stars/messageTool.ts";
import * as SleepTool from "./stars/sleepTool.ts";
import { starsRoute } from "./stars/routes.ts";
import * as Stars from "./stars/stars.ts";

/**
 * What this build does, one name per feature the page relies on; the page
 * reads it on each connect, and anything but this JSON means no plugin.
 * `star-schedules` is named only where this server fires them.
 */
const features: ReadonlyArray<string> = [
  "stars",
  "star-messages",
  "star-sleep-request",
  "star-sleep",
  "star-asks",
];

export const activate = Effect.fn("PultPlugin.activate")(function* (host: PluginHost) {
  const deliverTo = yield* Delivery.make;
  const stars = yield* Stars.make;
  const schedules = yield* Schedules.make(stars, deliverTo(stars));
  const tools = Layer.mergeAll(
    yield* MessageTool.make(stars, deliverTo(stars)),
    yield* SleepTool.make(stars),
  );
  yield* host.serve((request, path) => {
    if ((request.method === "GET" || request.method === "HEAD") && path === "/about")
      return Effect.map(schedules.firing, (firing) =>
        HttpServerResponse.jsonUnsafe({
          features: firing ? [...features, "star-schedules"] : features,
        }),
      );
    return (
      starsRoute(stars, schedules, request, path) ??
      Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    );
  });
  // A tool is replaced by name on every activation and never removed, so the tools register last.
  yield* Layer.build(tools);
});
