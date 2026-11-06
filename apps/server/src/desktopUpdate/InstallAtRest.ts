import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { HostPowerSnapshot } from "@t3tools/contracts";

import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerActivity from "../serverActivity.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

/** Opts a desktop-managed server into installing its desktop app's updates while nobody needs it. */
const INSTALL_UPDATES_AT_REST_ENV = "T3CODE_DESKTOP_INSTALL_UPDATES_AT_REST";

const TICK_INTERVAL = Duration.minutes(30);
const REST_REQUIRED = Duration.minutes(15);
const HOST_IDLE_REQUIRED = Duration.minutes(15);
const FRESH_SAMPLE_TIMEOUT = Duration.seconds(10);

/**
 * A host sample taken after this call, or none if the desktop sends none in time: the periodic
 * one can be two minutes old once the host idles, and input triggers none.
 */
const freshHostPower = Effect.gen(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const requestedAt = yield* DateTime.now;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { changes } = yield* receiver.subscribe;
      yield* receiver.requestHostPowerSample;
      return yield* changes.pipe(
        Stream.map((sample) => sample.power),
        Stream.filter((power) => !DateTime.isLessThan(power.updatedAt, requestedAt)),
        Stream.runHead,
        Effect.timeout(FRESH_SAMPLE_TIMEOUT),
      );
    }),
  ).pipe(Effect.catch(() => Effect.succeedNone));
});

/** Why the server would not install now, judged on this host sample, or null when it would. */
const refusal = Effect.fn("desktopUpdate.installAtRest.refusal")(function* (
  host: Option.Option<HostPowerSnapshot>,
) {
  const activity = yield* ServerActivity.ServerActivity;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const [{ restingSince }, now, { latest }] = yield* Effect.all([
    activity.current,
    DateTime.now,
    Effect.scoped(receiver.desktopUpdates),
  ]);
  // Its install restarted the server for nothing; Restart to Update retries it, not the worker.
  const update = Option.getOrUndefined(latest)?.state;
  if (
    update?.installFailedVersion !== undefined &&
    update.installFailedVersion === update.downloadedVersion
  ) {
    return `the last install of ${update.installFailedVersion} failed`;
  }
  if (
    restingSince === null ||
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(restingSince) <
      Duration.toMillis(REST_REQUIRED)
  ) {
    return "the server has not been at rest long enough";
  }
  // Missing or stale telemetry says nothing about the user, so it never counts as idle.
  if (Option.isNone(host)) return "the desktop sent no fresh host sample";
  const snapshot = host.value;
  if (
    snapshot.stale ||
    snapshot.idleSeconds === null ||
    snapshot.idleSeconds * 1000 <= Duration.toMillis(HOST_IDLE_REQUIRED)
  ) {
    return "the host has had input recently";
  }
  return null;
});

const tick = Effect.fn("desktopUpdate.installAtRest.tick")(function* (
  lastReason: Ref.Ref<string | null>,
) {
  const update = yield* DesktopAppUpdate.DesktopAppUpdate;
  const power = yield* HostPowerMonitor.HostPowerMonitor;
  // A quiet night answers the same each tick, so only a new reason is worth a line.
  const notInstalled = (reason: string) =>
    Ref.getAndSet(lastReason, reason).pipe(
      Effect.flatMap((last) =>
        (last === reason ? Effect.logDebug : Effect.logInfo)(
          "Desktop app update not installed at rest.",
          { reason },
        ),
      ),
    );
  if ((yield* refusal(Option.some(yield* power.snapshot))) !== null) return;
  // Up to date comes back as a failure too, untyped; either way the next tick asks again.
  const prepared = yield* update
    .run(() => Effect.void)
    .pipe(Effect.catch((error) => notInstalled(error.reason).pipe(Effect.as(null))));
  if (prepared?.desktopUpdateToken === undefined) return;
  // The download and prepare took minutes; someone may be back.
  const late = yield* refusal(yield* freshHostPower);
  if (late !== null) {
    yield* notInstalled(`prepared ${prepared.targetVersion}, but ${late}`);
    return;
  }
  yield* Ref.set(lastReason, null);
  yield* Effect.logInfo("Installing the desktop app update at rest.", {
    targetVersion: prepared.targetVersion,
  });
  yield* update.commit(prepared.desktopUpdateToken).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Desktop app update failed to install at rest.", {
        reason: error.reason,
      }),
    ),
  );
});

const make = Effect.gen(function* () {
  const enabled = yield* Config.Boolean(INSTALL_UPDATES_AT_REST_ENV).pipe(
    Config.withDefault(false),
  );
  if (!enabled) return;
  const update = yield* DesktopAppUpdate.DesktopAppUpdate;
  if (!update.available) {
    yield* Effect.logInfo(
      `${INSTALL_UPDATES_AT_REST_ENV} is set, but this server is not managed by a desktop app.`,
    );
    return;
  }
  yield* Effect.logInfo("Desktop app updates install while the server and the host rest.");
  const lastReason = yield* Ref.make<string | null>(null);
  yield* forkParked(
    Effect.forever(Effect.sleep(TICK_INTERVAL).pipe(Effect.andThen(tick(lastReason)))),
  );
});

export const layer = Layer.effectDiscard(make);
