// What the Limits shelf shows of the provider accounts' usage windows (xaxis `pult/issues/provider-limits-page`):
// which windows show, which warn, and what each of the shelf's modes leaves in.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { paceOf } from "@t3tools/shared/usageLimits";

/** The shelf's modes, `pult.panel.usageLimits`, in the order the settings page and the palette's pick list them. */
export const USAGE_LIMITS_MODES = [
  { mode: "warn", label: "When warning", description: "Only the limits past 95% or running out before their reset." },
  { mode: "always", label: "Always", description: "Every limit with something spent." },
  { mode: "hidden", label: "Hidden", description: "No Limits shelf; Pult: Show Usage Limits still shows it." },
] as const;

export type UsageLimitsMode = (typeof USAGE_LIMITS_MODES)[number]["mode"];

/** How much of a window is spent before it warns, whatever its pace. */
const WARNING_USED_PERCENT = 95;

/** A window shows only once something of it is spent. */
export const showsWindow = (window: ServerProviderUsageWindow) => window.usedPercent > 0;

/**
 * A window warns past 95% used, or while its pace runs out before its reset
 * (`paceOf`, upstream's five-point tolerance); one with no reset clock warns
 * on the 95% rule alone.
 */
export const warns = (window: ServerProviderUsageWindow, now: number) =>
  window.usedPercent > WARNING_USED_PERCENT || paceOf(window, now) === "ahead";

/** What the shelf needs of an account: its windows (`LimitAccount` from `@t3tools/shared/usageLimits`). */
interface AccountRef {
  readonly limits: { readonly windows: ReadonlyArray<ServerProviderUsageWindow> };
}

export interface ShelfWindow {
  readonly window: ServerProviderUsageWindow;
  readonly warning: boolean;
}

export interface ShelfAccount<Account extends AccountRef> {
  readonly account: Account;
  readonly windows: ReadonlyArray<ShelfWindow>;
}

/** The shelf as it shows: its accounts with their windows, the warning windows' count, and the row that shows more or less, if any. */
export interface LimitsShelf<Account extends AccountRef> {
  readonly accounts: ReadonlyArray<ShelfAccount<Account>>;
  readonly warnings: number;
  readonly toggle: "all" | "less" | null;
}

/**
 * The shelf in `mode`, or null while it is gone: every window that shows
 * while `showAll` (its Show all, or Pult: Show Usage Limits) or `always`;
 * in `warn` the warning windows alone, with Show all while others would
 * show, gone while none warns; in `hidden` gone. An account shows while it
 * has a window to show; Show less returns from `showAll` to a mode that
 * shows less.
 */
export function limitsShelf<Account extends AccountRef>(
  accounts: ReadonlyArray<Account>,
  now: number,
  mode: UsageLimitsMode,
  showAll: boolean,
): LimitsShelf<Account> | null {
  const all = accounts
    .map((account) => ({
      account,
      windows: account.limits.windows.filter(showsWindow).map((window) => ({ window, warning: warns(window, now) })),
    }))
    .filter((account) => account.windows.length > 0);
  const shown = all.reduce((count, account) => count + account.windows.length, 0);
  const warnings = all.reduce((count, account) => count + account.windows.filter((window) => window.warning).length, 0);
  if (showAll || mode === "always") {
    return all.length === 0 ? null : { accounts: all, warnings, toggle: mode === "always" ? null : "less" };
  }
  if (mode === "hidden" || warnings === 0) return null;
  return {
    accounts: all
      .map((account) => ({ ...account, windows: account.windows.filter((window) => window.warning) }))
      .filter((account) => account.windows.length > 0),
    warnings,
    toggle: shown > warnings ? "all" : null,
  };
}
