import { describe, expect, it } from "@effect/vitest";
import {
  ServerSelfUpdateError,
  type DesktopHostTelemetrySnapshot,
  type DesktopUpdateState,
  type HostPowerSnapshot,
  type ServerActivitySnapshot,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerActivity from "../serverActivity.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";
import * as InstallAtRest from "./InstallAtRest.ts";

const MINUTE = 60_000;

const idleHost = (idleSeconds: number | null, stale = false): HostPowerSnapshot => ({
  source: "electron-main",
  idle: "unknown",
  idleSeconds,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale,
  updatedAt: DateTime.makeUnsafe(0),
});

const restingSince = (epochMillis: number): ServerActivitySnapshot => ({
  atRest: true,
  restingSince: DateTime.makeUnsafe(epochMillis),
});
const busy: ServerActivitySnapshot = { atRest: false, restingSince: null };

const downloaded = (overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.0.1",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.0.2",
  downloadedVersion: "0.0.2",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
  ...overrides,
});

const prepared: ServerSelfUpdateResult = {
  targetVersion: "0.0.2",
  method: "desktop-app",
  desktopUpdateToken: "token-1",
};

interface Harness {
  readonly env?: Record<string, string>;
  readonly available?: boolean;
  readonly activity?: ServerActivitySnapshot;
  readonly power?: HostPowerSnapshot;
  /** The desktop answers a request for a fresh host sample. */
  readonly answersSamples?: boolean;
  /** The desktop's update state, as its latest report carries it. */
  readonly update?: DesktopUpdateState;
  /** What a run answers; it may change the activity or the host on the way. */
  readonly run?: (state: {
    readonly activity: Ref.Ref<ServerActivitySnapshot>;
    readonly power: Ref.Ref<HostPowerSnapshot>;
    readonly live: Ref.Ref<HostPowerSnapshot | null>;
    readonly runs: number;
  }) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
}

const start = Effect.fn(function* (options: Harness = {}) {
  const calls: string[] = [];
  const activity = yield* Ref.make(options.activity ?? restingSince(0));
  const power = yield* Ref.make(options.power ?? idleHost(20 * 60));
  // A fresh sample reads `live`, or `power` while it is null; `power` is the last periodic one.
  const live = yield* Ref.make<HostPowerSnapshot | null>(null);
  const update = yield* Ref.make(options.update ?? downloaded());
  const samples = yield* PubSub.unbounded<DesktopHostTelemetrySnapshot>();
  const sampleNow = Effect.gen(function* () {
    const host = (yield* Ref.get(live)) ?? (yield* Ref.get(power));
    const now = yield* DateTime.now;
    yield* PubSub.publish(samples, {
      version: 1,
      type: "desktopTelemetry",
      sequence: 1,
      sampledAtUnixMs: DateTime.toEpochMillis(now),
      electronPid: 1,
      power: { ...host, updatedAt: now },
      speedLimitPercent: Option.none(),
      electronProcesses: [],
    });
  });
  const run = options.run ?? (() => Effect.succeed(prepared));
  yield* Layer.build(
    InstallAtRest.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            ServerActivity.ServerActivity,
            ServerActivity.ServerActivity.of({ current: Ref.get(activity) }),
          ),
          Layer.succeed(
            HostPowerMonitor.HostPowerMonitor,
            HostPowerMonitor.HostPowerMonitor.of({
              snapshot: Ref.get(power),
              report: () => Effect.void,
              streamChanges: Stream.empty,
            }),
          ),
          DesktopTelemetryReceiver.layerTest({
            subscribe: PubSub.subscribe(samples).pipe(
              Effect.map((subscription) => ({
                latest: Option.none(),
                changes: Stream.fromSubscription(subscription),
              })),
            ),
            requestHostPowerSample: options.answersSamples === false ? Effect.void : sampleNow,
            desktopUpdates: Ref.get(update).pipe(
              Effect.map((state) => ({
                latest: Option.some({
                  version: 1 as const,
                  type: "desktopUpdateStatus" as const,
                  state,
                }),
                changes: Stream.empty,
              })),
            ),
          }),
          Layer.succeed(
            DesktopAppUpdate.DesktopAppUpdate,
            DesktopAppUpdate.DesktopAppUpdate.of({
              available: options.available ?? true,
              run: () =>
                Effect.suspend(() => {
                  calls.push("run");
                  return run({
                    activity,
                    power,
                    live,
                    runs: calls.filter((c) => c === "run").length,
                  });
                }),
              commit: (token) =>
                Effect.sync(() => calls.push(`commit ${token}`)).pipe(Effect.andThen(Effect.never)),
            }),
          ),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: options.env ?? { T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST: "true" },
            }),
          ),
        ),
      ),
    ),
  );
  return { calls, activity, power, update };
});

describe("InstallAtRest", () => {
  it.effect("installs once the server and the host have rested, on the half hour", () =>
    Effect.gen(function* () {
      const { calls } = yield* start();
      yield* TestClock.adjust(29 * MINUTE);
      expect(calls).toEqual([]);
      yield* TestClock.adjust(MINUTE);
      expect(calls).toEqual(["run", "commit token-1"]);
    }),
  );

  it.effect("stays off unless the variable turns it on", () =>
    Effect.gen(function* () {
      for (const env of [{}, { T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST: "false" }]) {
        const { calls } = yield* start({ env });
        yield* TestClock.adjust(60 * MINUTE);
        expect(calls).toEqual([]);
      }
    }),
  );

  it.effect("does nothing on a server no desktop app manages", () =>
    Effect.gen(function* () {
      const { calls } = yield* start({ available: false });
      yield* TestClock.adjust(60 * MINUTE);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("waits until the server has rested fifteen minutes", () =>
    Effect.gen(function* () {
      const { calls, activity } = yield* start({ activity: busy });
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual([]);
      yield* Ref.set(activity, restingSince(50 * MINUTE));
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual([]);
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "commit token-1"]);
    }),
  );

  it.effect(
    "waits for fifteen minutes without input, and treats missing or stale telemetry as input",
    () =>
      Effect.gen(function* () {
        const { calls, power } = yield* start({ power: idleHost(15 * 60) });
        for (const host of [idleHost(15 * 60), idleHost(null), idleHost(20 * 60, true)]) {
          yield* Ref.set(power, host);
          yield* TestClock.adjust(30 * MINUTE);
          expect(calls).toEqual([]);
        }
        yield* Ref.set(power, idleHost(15 * 60 + 1));
        yield* TestClock.adjust(30 * MINUTE);
        expect(calls).toEqual(["run", "commit token-1"]);
      }),
  );

  it.effect("skips the install when work starts during the download", () =>
    Effect.gen(function* () {
      const { calls } = yield* start({
        run: ({ activity }) => Ref.set(activity, busy).pipe(Effect.as(prepared)),
      });
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run"]);
    }),
  );

  it.effect("skips the install when the host wakes during the download", () =>
    Effect.gen(function* () {
      const { calls, power } = yield* start({
        run: ({ power, runs }) =>
          (runs === 1 ? Ref.set(power, idleHost(30)) : Effect.void).pipe(Effect.as(prepared)),
      });
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run"]);
      // The download retained, the next tick prepares it again and installs.
      yield* Ref.set(power, idleHost(20 * 60));
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "run", "commit token-1"]);
    }),
  );

  it.effect("checks the host again on a sample taken after the download", () =>
    Effect.gen(function* () {
      // The last periodic sample, minutes old, still reads idle; the host has had input since.
      const { calls } = yield* start({
        run: ({ live }) => Ref.set(live, idleHost(40)).pipe(Effect.as(prepared)),
      });
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run"]);
    }),
  );

  it.effect("does not install without a fresh host sample", () =>
    Effect.gen(function* () {
      const { calls } = yield* start({ answersSamples: false });
      yield* TestClock.adjust(31 * MINUTE);
      expect(calls).toEqual(["run"]);
      // It gave up waiting, so the next tick runs.
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "run"]);
    }),
  );

  it.effect("leaves a download whose last install failed to Restart to Update", () =>
    Effect.gen(function* () {
      const { calls, update } = yield* start({
        update: downloaded({ installFailedVersion: "0.0.2", errorContext: null }),
      });
      yield* TestClock.adjust(60 * MINUTE);
      expect(calls).toEqual([]);
      // A newer release replaces the download, and the worker installs that.
      yield* Ref.set(
        update,
        downloaded({
          installFailedVersion: "0.0.2",
          availableVersion: "0.0.3",
          downloadedVersion: "0.0.3",
        }),
      );
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "commit token-1"]);
    }),
  );

  it.effect("logs why it did not install once, until the reason changes", () => {
    const lines: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      const [text, fields] = Array.isArray(message) ? message : [message];
      if (text === "Desktop app update not installed at rest.")
        lines.push(`${logLevel} ${(fields as { readonly reason: string }).reason}`);
    });
    return Effect.gen(function* () {
      yield* start({
        run: ({ runs }) =>
          Effect.fail(
            new ServerSelfUpdateError({
              reason: runs < 3 ? "Already up to date on 0.0.1." : "Network down.",
            }),
          ),
      });
      yield* TestClock.adjust(4 * 30 * MINUTE);
      expect(lines).toEqual([
        "Info Already up to date on 0.0.1.",
        "Debug Already up to date on 0.0.1.",
        "Info Network down.",
        "Debug Network down.",
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

  it.effect("tries again next tick after a failure or when up to date", () =>
    Effect.gen(function* () {
      const { calls } = yield* start({
        run: ({ runs }) =>
          runs === 1
            ? Effect.fail(new ServerSelfUpdateError({ reason: "Network down." }))
            : runs === 2
              ? Effect.fail(new ServerSelfUpdateError({ reason: "Already up to date on 0.0.1." }))
              : Effect.succeed(prepared),
      });
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run"]);
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "run"]);
      yield* TestClock.adjust(30 * MINUTE);
      expect(calls).toEqual(["run", "run", "run", "commit token-1"]);
    }),
  );
});
