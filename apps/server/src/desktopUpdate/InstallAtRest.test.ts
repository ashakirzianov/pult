import { describe, expect, it } from "@effect/vitest";
import {
  ServerSelfUpdateError,
  type HostPowerSnapshot,
  type ServerActivitySnapshot,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
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
  /** What a run answers; it may change the activity or the host on the way. */
  readonly run?: (state: {
    readonly activity: Ref.Ref<ServerActivitySnapshot>;
    readonly power: Ref.Ref<HostPowerSnapshot>;
    readonly runs: number;
  }) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
}

const start = Effect.fn(function* (options: Harness = {}) {
  const calls: string[] = [];
  const activity = yield* Ref.make(options.activity ?? restingSince(0));
  const power = yield* Ref.make(options.power ?? idleHost(20 * 60));
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
          Layer.succeed(
            DesktopAppUpdate.DesktopAppUpdate,
            DesktopAppUpdate.DesktopAppUpdate.of({
              available: options.available ?? true,
              run: () =>
                Effect.suspend(() => {
                  calls.push("run");
                  return run({ activity, power, runs: calls.filter((c) => c === "run").length });
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
  return { calls, activity, power };
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
