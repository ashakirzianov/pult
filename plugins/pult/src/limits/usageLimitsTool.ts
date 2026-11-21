// `pult_usage_limits` (xaxis `pult/tasks/limits-tool-for-agents.task`, `usage-limits-go-stale.md`): this
// server's usage limits, paced and warned, refreshed when older than five minutes at most once per five
// minutes, as upstream's timer needs a page in front. `collectLimitAccounts` drops every account whose
// limits are unavailable, so an account carries no `unavailable`: only a notice tells of it.
import {
  isProviderAvailable,
  IsoDateTime,
  ProviderDriverKind,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  elapsedShare,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { collectLimitNotices } from "@t3tools/shared/usageLimitsCopy";

import {
  DateTime,
  Effect,
  Fiber,
  McpToolAccess,
  Option,
  ProviderRegistry,
  Schema,
  ServerEnvironment,
  Tool,
  Toolkit,
  toolkitRegistration,
  UsageLimitSources,
} from "../host.ts";

/** The Limits shelf's thresholds (`apps/pult/src/limits/limits.ts`). */
const WARNING_USED_PERCENT = 95;
const PACE_TOLERANCE_PERCENT = 5;

/**
 * The shelf's default weekend, Saturday and Sunday (`weekDay` numbers, Sunday 0): the convention
 * paces on Monday to Friday (`axis/decisions.md`, `models-and-pacing`), and the shelf's setting is the page's.
 */
const WEEKEND: ReadonlySet<number> = new Set([6, 0]);

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/** Upstream's provider status interval and Claude's probe cache: both the staleness line and the floor between refreshes. */
const REFRESH_AFTER_MS = 5 * 60_000;
/** Above Claude's 25-second probe deadline. */
const REFRESH_WAIT = "30 seconds";

const UsageLimitsTool = Tool.make("pult_usage_limits", {
  description:
    "The usage limits this server holds for its provider accounts and its usage hubs, and nothing of other environments: per account, its `checkedAt` (when its limits were read) and each window with its length, the share used, its reset, `evenPercent` (the share of the window's time gone, where for a window of a day or longer only its time Monday to Friday counts, in this server's time zone, unless it has none, so spending at that pace uses the window up by its reset; null without a reset time or a length) and `warning` (over 95% used, or more than 5 points past `evenPercent`), and `notices`, upstream's for this server. A read first refreshes the limits when any is older than five minutes, at most once per five minutes, waiting up to 30 seconds. An account whose limits could not be read, or report none, is not listed, and a notice says why; one with no subscription limits (an API key) is left out with no notice; a hub whose read failed lists none of its accounts, only its notice. A provider whose read fails after a good one keeps its last good windows with their `checkedAt`, so an account whose `checkedAt` is more than fifteen minutes before `now` has no current numbers.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    now: IsoDateTime,
    accounts: Schema.Array(
      Schema.Struct({
        provider: ProviderDriverKind,
        displayName: Schema.NullOr(Schema.String),
        email: Schema.NullOr(Schema.String),
        plan: Schema.NullOr(Schema.String),
        hub: Schema.NullOr(Schema.String),
        checkedAt: IsoDateTime,
        windows: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            kind: ServerProviderUsageWindow.fields.kind,
            label: Schema.String,
            lengthMins: Schema.NullOr(Schema.Number),
            usedPercent: Schema.Number,
            resetsAt: Schema.NullOr(IsoDateTime),
            evenPercent: Schema.NullOr(Schema.Number),
            warning: Schema.Boolean,
          }),
        ),
      }),
    ),
    notices: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Title, "Read usage limits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const UsageLimitsToolkit = Toolkit.make(UsageLimitsTool);

/** The tool's registration, to build in the plugin's activation once everything else is up. */
export const make = Effect.fn("PultTools.makeUsageLimits")(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  /** The last refresh this tool asked for, and when, in epoch millis; null before its first. */
  let last: { readonly at: number; readonly refresh: Fiber.Fiber<void> } | null = null;

  // The shelf's Refresh, `server.refreshProviders`, beside the hubs'. A stale read inside the floor
  // waits on the last refresh, so readers arriving while it runs answer what it reads.
  const refreshIfStale = Effect.fn("PultTools.refreshStaleUsageLimits")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const checkedAt = [
      ...(yield* registry.getProviders).flatMap((provider) =>
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider) &&
        provider.usageLimits !== undefined &&
        provider.usageLimits.unavailable?.reason !== "unsupported"
          ? [provider.usageLimits.checkedAt]
          : [],
      ),
      ...(yield* sources.current).map((source) => source.checkedAt),
    ];
    if (!checkedAt.some((at) => now - Date.parse(at) > REFRESH_AFTER_MS)) return;
    if (last === null || now - last.at > REFRESH_AFTER_MS) {
      // Detached, so the wait's timeout leaves the refresh running rather than interrupting it.
      const refresh = yield* Effect.all([registry.refresh(), sources.refresh], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.forkDetach);
      last = { at: now, refresh };
    }
    yield* Fiber.await(last.refresh).pipe(Effect.timeoutOption(REFRESH_WAIT));
  });

  const read = Effect.fn("PultTools.readUsageLimits")(function* () {
    yield* refreshIfStale();
    const descriptor = yield* environment.getDescriptor;
    const presentations: LimitPresentations = new Map([
      [
        descriptor.environmentId,
        {
          entry: { target: { label: descriptor.label } },
          serverConfig: {
            providers: yield* registry.getProviders,
            usageLimitSources: yield* sources.current,
          },
        },
      ],
    ]);
    const now = yield* DateTime.now;
    const millis = DateTime.toEpochMillis(now);
    // The server's own zone; a test provides one.
    const zone = Option.getOrElse(
      yield* Effect.serviceOption(DateTime.CurrentTimeZone),
      DateTime.zoneMakeLocal,
    );
    return {
      now: DateTime.formatIso(now),
      accounts: collectLimitAccounts(presentations).map((account) => ({
        provider: account.driver,
        displayName: account.displayName,
        email: account.email ?? null,
        plan: account.plan ?? null,
        hub: account.sourceLabel,
        checkedAt: account.limits.checkedAt,
        windows: account.limits.windows.map((window) => {
          const share = paceShare(window, millis, zone);
          const evenPercent = share === null ? null : Math.round(share * 1000) / 10;
          return {
            id: window.id,
            kind: window.kind,
            label: window.label,
            lengthMins: window.windowDurationMins ?? null,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
            evenPercent,
            warning:
              window.usedPercent > WARNING_USED_PERCENT ||
              (evenPercent !== null && window.usedPercent - evenPercent > PACE_TOLERANCE_PERCENT),
          };
        }),
      })),
      notices: collectLimitNotices(presentations),
    };
  });

  return toolkitRegistration(
    UsageLimitsToolkit,
    McpToolAccess.toLayer(UsageLimitsToolkit, { pult_usage_limits: McpToolAccess.reads(read) }),
  );
});

/**
 * The shelf's `paceShare` (`apps/pult/src/limits/limits.ts`) over its default weekend, at the
 * `zone`'s midnights: for a window of a day or longer, the share of its time outside the weekend
 * gone; a shorter window, or one with no time outside the weekend, by the calendar
 * (`elapsedShare`). Null with no reset clock.
 */
function paceShare(
  window: ServerProviderUsageWindow,
  now: number,
  zone: DateTime.TimeZone,
): number | null {
  const share = elapsedShare(window, now);
  const { resetsAt, windowDurationMins: minutes } = window;
  // A share means both are there.
  if (share === null || resetsAt === undefined || minutes === undefined) return share;
  if (minutes < DAY_MINUTES) return share;
  const end = Date.parse(resetsAt);
  const start = end - minutes * MINUTE;
  const working = workingMillis(start, end, zone);
  if (working === 0) return share;
  return workingMillis(start, Math.max(start, Math.min(now, end)), zone) / working;
}

/** The time from `from` to `to` on days outside the weekend, day by day at the `zone`'s midnights. */
function workingMillis(from: number, to: number, zone: DateTime.TimeZone): number {
  let total = 0;
  for (let at = from; at < to;) {
    const day = DateTime.makeZonedUnsafe(at, { timeZone: zone });
    const until = Math.min(
      to,
      DateTime.toEpochMillis(DateTime.add(DateTime.startOf(day, "day"), { days: 1 })),
    );
    if (!WEEKEND.has(DateTime.toParts(day).weekDay)) total += until - at;
    at = until;
  }
  return total;
}
