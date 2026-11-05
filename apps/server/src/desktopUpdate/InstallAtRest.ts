import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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

/** Why the server would not install now, or null when it would. */
const refusal = Effect.gen(function* () {
  const activity = yield* ServerActivity.ServerActivity;
  const power = yield* HostPowerMonitor.HostPowerMonitor;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const [{ restingSince }, snapshot, now, { latest }] = yield* Effect.all([
    activity.current,
    power.snapshot,
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
  if (
    snapshot.stale ||
    snapshot.idleSeconds === null ||
    snapshot.idleSeconds * 1000 <= Duration.toMillis(HOST_IDLE_REQUIRED)
  ) {
    return "the host has had input recently";
  }
  return null;
});

const tick = Effect.fn("desktopUpdate.installAtRest.tick")(function* () {
  const update = yield* DesktopAppUpdate.DesktopAppUpdate;
  if ((yield* refusal) !== null) return;
  // Up to date comes back as a failure too; either way the next tick asks again.
  const prepared = yield* update
    .run(() => Effect.void)
    .pipe(
      Effect.catch((error) =>
        Effect.logInfo("Desktop app update not installed at rest.", { reason: error.reason }).pipe(
          Effect.as(null),
        ),
      ),
    );
  if (prepared?.desktopUpdateToken === undefined) return;
  // The download and prepare took minutes; someone may be back.
  const late = yield* refusal;
  if (late !== null) {
    yield* Effect.logInfo("Desktop app update prepared but not installed at rest.", {
      targetVersion: prepared.targetVersion,
      reason: late,
    });
    return;
  }
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
  yield* forkParked(Effect.forever(Effect.sleep(TICK_INTERVAL).pipe(Effect.andThen(tick()))));
});

export const layer = Layer.effectDiscard(make);
