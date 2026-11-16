// `pult_usage_limits` (xaxis `pult/issues/limits-tool-for-agents.md`): an agent reads this server's
// usage limits, each window with a linear even pace and a warning; it refreshes nothing. Upstream's
// `collectLimitAccounts` drops every account whose limits are unavailable, so an account carries no
// `unavailable`: only a notice tells of it.
import { IsoDateTime, ProviderDriverKind, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitNotices,
  elapsedShare,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

import {
  DateTime,
  Effect,
  McpToolAccess,
  ProviderRegistry,
  Schema,
  ServerEnvironment,
  Tool,
  Toolkit,
  toolkitRegistration,
  UsageLimitSources,
} from "../host.ts";

/** The Limits shelf's thresholds (`apps/pult/src/limits/limits.ts`), here over the linear pace. */
const WARNING_USED_PERCENT = 95;
const PACE_TOLERANCE_PERCENT = 5;

const UsageLimitsTool = Tool.make("pult_usage_limits", {
  description:
    "The usage limits this server holds for its provider accounts and its usage hubs, and nothing of other environments: per account, its `checkedAt` (when its limits were read) and each window with its length, the share used, its reset, `evenPercent` (the share of the window's time gone, by the calendar, so spending at that pace uses the window up exactly at its reset; null without a reset time or a length) and `warning` (over 95% used, or more than 5 points past `evenPercent`), and `notices`, upstream's for this server. It refreshes nothing. An account whose limits could not be read, or report none, is not listed, and a notice says why; one with no subscription limits (an API key) is left out with no notice; a hub whose read failed lists none of its accounts, only its notice. A provider whose read fails after a good one keeps its last good windows with their `checkedAt`, so an account whose `checkedAt` is more than fifteen minutes before `now` has no current numbers.",
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

  const read = Effect.fn("PultTools.readUsageLimits")(function* () {
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
          const share = elapsedShare(window, millis);
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
