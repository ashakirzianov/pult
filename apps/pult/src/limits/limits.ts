// What the Limits shelf shows of the provider accounts' usage windows (xaxis `pult/issues/provider-limits-page`):
// which windows show, which warn, and which of them the shelf lists.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { paceOf } from "@t3tools/shared/usageLimits";

/** How much of a window is spent before it warns, whatever its pace. */
const WARNING_USED_PERCENT = 95;

/** A window shows only once something of it is spent. */
const showsWindow = (window: ServerProviderUsageWindow) => window.usedPercent > 0;

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
 * The shelf, or null while it is gone, no window having anything spent:
 * while any window warns, the warning windows alone, with Show all while
 * others would show, and everything while `showAll` (its Show all, or Pult:
 * Show Usage Limits), with Show less; while none warns, every window that
 * shows. An account shows while it has a window to show.
 */
export function limitsShelf<Account extends AccountRef>(
  accounts: ReadonlyArray<Account>,
  now: number,
  showAll: boolean,
): LimitsShelf<Account> | null {
  const all = accounts
    .map((account) => ({
      account,
      windows: account.limits.windows
        .filter(showsWindow)
        .map((window) => ({ window, warning: warns(window, now) })),
    }))
    .filter((account) => account.windows.length > 0);
  if (all.length === 0) return null;
  const shown = all.reduce((count, account) => count + account.windows.length, 0);
  const warnings = all.reduce(
    (count, account) => count + account.windows.filter((window) => window.warning).length,
    0,
  );
  // Nothing to tell apart: every window that shows is a warning, or none is.
  if (warnings === 0 || warnings === shown) return { accounts: all, warnings, toggle: null };
  if (showAll) return { accounts: all, warnings, toggle: "less" };
  return {
    accounts: all
      .map((account) => ({
        ...account,
        windows: account.windows.filter((window) => window.warning),
      }))
      .filter((account) => account.windows.length > 0),
    warnings,
    toggle: "all",
  };
}
