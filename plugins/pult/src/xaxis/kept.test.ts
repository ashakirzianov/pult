// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// The kept xaxis checkout through the plugin's activation and its route, the real driver over a real
// `xaxis` against `scm-server serve` (xaxis `pult/tasks/xaxis-checkouts-on-main.task`, "Test plan").
// Skipped, with the reason printed, unless XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the binaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthSessionId, RunId } from "@t3tools/contracts";
import * as HttpRouter from "effect/http/HttpRouter";
import * as TestClock from "effect/testing/TestClock";

// The real loader, bundled list, routes and driver, which the plugin itself never imports.
import * as EnvironmentAuth from "../../../../apps/server/src/auth/EnvironmentAuth.ts";
import { bundledPlugins } from "../../../../apps/server/src/plugins/bundled.ts";
import * as PluginsHttp from "../../../../apps/server/src/plugins/http.ts";
import * as PluginLoader from "../../../../apps/server/src/plugins/PluginLoader.ts";
import * as ExtensionUi from "../../../../apps/server/src/plugins/ExtensionUi.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import * as VcsProcess from "../../../../apps/server/src/vcs/VcsProcess.ts";
import {
  skipped,
  startXaxisTestServer,
  suiteName,
  UNKNOWN_TOKEN,
  XAXIS,
  type XaxisTestServer,
} from "../../../../apps/server/src/vcs/XaxisVcsDriver.testkit.ts";
import {
  Context,
  Duration,
  Effect,
  type HttpServerRequest,
  Layer,
  McpServer,
  VcsAutomaticFetchInterval,
  VcsStatusBroadcaster,
  XaxisVcsDriver,
} from "../host.ts";
import { fakeServer } from "../stars/testing.ts";
import type { KeptView } from "./kept.ts";

const environmentAuth = {
  authenticateHttpRequest: (_request: HttpServerRequest.HttpServerRequest) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("session-1"),
      subject: "test",
      method: "bearer-access-token" as const,
      scopes: [AuthOrchestrationReadScope],
    }),
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

describe.skipIf(skipped)(suiteName("the kept xaxis checkout"), () => {
  let harness: XaxisTestServer;
  let writer = "";
  const xaxis = (cwd: string, ...args: string[]) => harness.xaxis(cwd, ...args);
  /** A file landed from the writer's checkout of `/test/repo`. */
  const land = (name: string, text: string) => {
    NodeFS.writeFileSync(NodePath.join(writer, name), text);
    xaxis(writer, "commit", "-m", name);
    xaxis(writer, "land");
  };

  beforeAll(async () => {
    harness = await startXaxisTestServer();
    xaxis(harness.scratch, "--server", harness.address, "checkout", "/test/repo", "writer");
    writer = NodePath.join(harness.scratch, "writer");
    land("first.txt", "first\n");
  });

  afterAll(() => harness?.stop());

  it.effect(
    "moves the checkout of / at <pult>/xaxis, makes it a project, and says why it cannot",
    () =>
      Effect.gen(function* () {
        const server = yield* fakeServer;
        const pult = NodePath.dirname(server.directory);
        const folder = NodePath.join(pult, "xaxis");
        const interval = { every: Duration.seconds(30) };
        const refreshed: string[] = [];
        const settingsContext = yield* Layer.build(
          ServerSettings.layerTest({ xaxisBinaryPath: XAXIS! }),
        );
        const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
        const layer = Layer.mergeAll(
          McpServer.McpServer.layer,
          XaxisVcsDriver.layer.pipe(
            // The real spawner: the server layer's fake one, which the Stars spawn through, has no output.
            Layer.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
            Layer.provide(Layer.succeedContext(settingsContext)),
          ),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshStatus: (cwd: string) =>
              Effect.sync(() => {
                refreshed.push(cwd);
                return {} as never;
              }),
          }),
          Layer.succeed(
            VcsAutomaticFetchInterval.VcsAutomaticFetchInterval,
            Effect.sync(() => interval.every),
          ),
        ).pipe(Layer.provideMerge(server.layer));
        const loader = Context.get(
          yield* Layer.build(
            PluginLoader.layer(bundledPlugins).pipe(
              Layer.provideMerge(ExtensionUi.layer),
              Layer.provide(layer),
            ),
          ),
          PluginLoader.PluginLoader,
        );
        expect((yield* loader.list).find((plugin) => plugin.name === "pult")).toMatchObject({
          status: "loaded",
          error: undefined,
        });
        const web = HttpRouter.toWebHandler(
          PluginsHttp.layerRoutes(loader).pipe(
            Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, environmentAuth)),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
        const kept = Effect.promise(async () => {
          const response = await web.handler(
            new Request("http://127.0.0.1/api/plugins/pult/xaxis/kept", {
              headers: { authorization: "Bearer reader" },
            }),
          );
          expect(response.status).toBe(200);
          return (await response.json()) as KeptView;
        });
        /** The scheduler's tick, once the interval has passed. */
        const tick = TestClock.adjust(interval.every).pipe(
          Effect.andThen(server.runSource("pult-xaxis-kept")),
        );
        const last = Effect.map(kept, (view) => view.checkouts[0]?.last);
        const keptProjects = () =>
          server.projects.shells.filter((project) => project.workspaceRoot === folder);
        const onDisk = (name: string) =>
          NodeFS.existsSync(NodePath.join(folder, "test", "repo", name));

        // No folder: nothing kept.
        yield* tick;
        expect(yield* kept).toEqual({ folder, checkouts: [], refused: [] });

        // A checkout of another prefix at the folder, and one nested in it: neither kept.
        NodeFS.mkdirSync(pult, { recursive: true });
        xaxis(pult, "--server", harness.address, "checkout", "/test/repo", "xaxis");
        xaxis(folder, "--server", harness.address, "checkout", "/test", "inner");
        yield* tick;
        const refusing = yield* kept;
        // In the registry's order, which it does not promise.
        expect({
          ...refusing,
          refused: refusing.refused.toSorted((x, y) => x.dir.localeCompare(y.dir)),
        }).toEqual({
          folder,
          checkouts: [],
          refused: [
            {
              dir: folder,
              reason: `It holds /test/repo, and only a checkout of the whole tree / is kept at ${folder}.`,
            },
            {
              dir: NodePath.join(folder, "inner"),
              reason: `It is nested inside ${folder}, where only the checkout of the whole tree / is kept.`,
            },
          ],
        });
        expect(keptProjects()).toEqual([]);
        NodeFS.rmSync(folder, { recursive: true });

        // The checkout of / at the folder mirrors its prefix: kept, made a project titled xaxis.
        xaxis(pult, "--server", harness.address, "checkout", "/", "xaxis");
        yield* tick;
        const [project] = keptProjects();
        expect(project?.title).toBe("xaxis");
        expect(yield* kept).toMatchObject({
          folder,
          checkouts: [
            {
              dir: folder,
              prefix: "/",
              projectId: project!.id,
              last: { outcome: "up-to-date" },
              agentThreads: [],
            },
          ],
          refused: [],
        });

        // Another checkout lands: the kept one moves, and an open page hears of it.
        land("second.txt", "second\n");
        yield* tick;
        expect(yield* last).toMatchObject({ outcome: "moved" });
        expect(onDisk("second.txt")).toBe(true);
        expect(refreshed).toEqual([folder]);

        // An edit holds it, in the CLI's words; undone, it moves.
        NodeFS.writeFileSync(NodePath.join(folder, "mine.txt"), "mine\n");
        land("third.txt", "third\n");
        yield* tick;
        expect(yield* last).toMatchObject({ outcome: "waiting", code: "uncommitted-edits" });
        expect(onDisk("third.txt")).toBe(false);
        NodeFS.rmSync(NodePath.join(folder, "mine.txt"));
        yield* tick;
        expect(yield* last).toMatchObject({ outcome: "moved" });
        expect(onDisk("third.txt")).toBe(true);

        // An interval of zero moves nothing.
        land("fourth.txt", "fourth\n");
        const before = yield* last;
        interval.every = Duration.zero;
        yield* TestClock.adjust("1 minute");
        yield* server.runSource("pult-xaxis-kept");
        expect(yield* last).toEqual(before);
        expect(onDisk("fourth.txt")).toBe(false);
        interval.every = Duration.seconds(30);

        // A login that does not hold fails with the CLI's code and refreshes the status; back, it moves.
        const token = process.env.XAXIS_TOKEN;
        process.env.XAXIS_TOKEN = UNKNOWN_TOKEN;
        yield* tick.pipe(Effect.ensuring(Effect.sync(() => (process.env.XAXIS_TOKEN = token))));
        const failed = yield* last;
        expect(failed).toMatchObject({ outcome: "failed", code: "unauthenticated" });
        expect(failed?.message).toEqual(expect.any(String));
        expect(refreshed).toEqual([folder, folder, folder]);
        yield* tick;
        expect(yield* last).toMatchObject({ outcome: "moved" });
        expect(onDisk("fourth.txt")).toBe(true);
        expect(keptProjects()).toHaveLength(1);

        // A thread running inside the checkout is named; one idle there, or running elsewhere, is not.
        server.threads.add(project!.id, "agent", { activeRunId: RunId.make("agent-run") });
        server.threads.add(project!.id, "idle", {});
        server.threads.add(project!.id, "away", {
          activeRunId: RunId.make("away-run"),
          worktreePath: harness.scratch,
        });
        server.threads.add(project!.id, "deeper", {
          activeRunId: RunId.make("deeper-run"),
          worktreePath: NodePath.join(folder, "test"),
        });
        expect((yield* kept).checkouts[0]?.agentThreads).toEqual(["agent", "deeper"]);

        // A CLI that cannot list the checkouts is named, in the driver's words.
        yield* settings.updateSettings({ xaxisBinaryPath: NodePath.join(pult, "no-xaxis") });
        expect(yield* kept).toEqual({
          folder,
          checkouts: [],
          refused: [],
          unlisted: expect.stringContaining("xaxis was not found"),
        });
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  );
});
