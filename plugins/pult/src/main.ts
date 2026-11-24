/**
 * Pult's plugin, compiled into the server and activated at startup
 * (docs/internals/plugins.md, Bundled plugins). Its routes are the one
 * `host.serve` dispatch below; its tools register last.
 */
import * as Asks from "./asks/asks.ts";
import { tellRetiredAsks } from "./asks/retired.ts";
import { asksRoute } from "./asks/routes.ts";
import * as AskTools from "./asks/tools.ts";
import { Effect, HttpServerResponse, Layer, type PluginHost, ProcessRunner } from "./host.ts";
import * as InstallAtRest from "./installAtRest/installAtRest.ts";
import * as UsageLimitsTool from "./limits/usageLimitsTool.ts";
import { runCommand } from "./schedules/command.ts";
import * as Schedules from "./schedules/schedules.ts";
import * as ChildFailures from "./stars/childFailures.ts";
import * as Delivery from "./stars/deliver.ts";
import * as ListTool from "./stars/listTool.ts";
import * as MessageTool from "./stars/messageTool.ts";
import * as SleepTool from "./stars/sleepTool.ts";
import { starsRoute } from "./stars/routes.ts";
import * as Stars from "./stars/stars.ts";
import * as XaxisKept from "./xaxis/kept.ts";

/**
 * What this build does, one name per feature the page relies on; the page
 * reads it on each connect, and anything but this JSON means no plugin.
 * `star-schedules` only where this server fires them.
 */
const features: ReadonlyArray<string> = [
  "stars",
  "star-messages",
  "star-sleep-request",
  "star-sleep",
  "star-channel-sleep",
  "asks",
  "star-channel-models",
  "star-channel-history",
  "usage-limits",
  "xaxis-kept",
];

export const activate = Effect.fn("PultPlugin.activate")(function* (host: PluginHost) {
  const deliverTo = yield* Delivery.make;
  const stars = yield* Stars.make;
  const delivering = deliverTo(stars);
  const asks = yield* Asks.make(stars, delivering.deliver);
  // Delivery waits for the server's commands, so the Stars with files left in `.pult/asks/` are told apart.
  yield* tellRetiredAsks(stars, delivering.deliver).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not look for the Stars' retired asks.", { error }),
    ),
    Effect.forkDetach,
  );
  // The server's own runner, over the spawner of its context.
  const runner = yield* ProcessRunner.ProcessRunner.pipe(Effect.provide(ProcessRunner.layer));
  const schedules = yield* Schedules.make(stars, delivering.deliver, (root, command) =>
    runCommand(root, command).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner)),
  );
  yield* ChildFailures.make(stars, delivering.deliver);
  // Only where the desktop app opts its server in; elsewhere it builds to nothing.
  yield* Layer.build(InstallAtRest.layer);
  const kept = yield* XaxisKept.make(stars.directory);
  const tools = Layer.mergeAll(
    yield* MessageTool.make(stars, delivering.deliver),
    yield* ListTool.make(stars),
    yield* SleepTool.make(stars),
    yield* UsageLimitsTool.make(),
    yield* AskTools.make(stars, asks),
  );
  yield* host.serve((request, path) => {
    if ((request.method === "GET" || request.method === "HEAD") && path === "/about")
      return Effect.map(schedules.firing, (firing) =>
        HttpServerResponse.jsonUnsafe({
          features: firing ? [...features, "star-schedules"] : features,
        }),
      );
    if ((request.method === "GET" || request.method === "HEAD") && path === "/xaxis/kept")
      return kept.view.pipe(
        Effect.map((view) => HttpServerResponse.jsonUnsafe(view)),
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 })),
        ),
      );
    return (
      starsRoute(stars, schedules, delivering.pageWakeModel, request, path) ??
      asksRoute(asks, request, path) ??
      Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    );
  });
  // A tool is replaced by name on every activation and never removed, so the tools register last.
  yield* Layer.build(tools);
});
