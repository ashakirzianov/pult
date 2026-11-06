// What the Limits shelf shows of the provider accounts' usage windows (xaxis `pult/issues/provider-limits-page`):
// which windows show, which warn, and which of them the shelf lists.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

/** How much of a window is spent before it warns, whatever its pace. */
const WARNING_USED_PERCENT = 95;

/** How far past even pace a window is spent before it warns, upstream's tolerance (`paceOf`). */
const PACE_TOLERANCE_PERCENT = 5;

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/** A window shows only once something of it is spent. */
const showsWindow = (window: ServerProviderUsageWindow) => window.usedPercent > 0;

/**
 * The share of a window's time gone, where even pace stands: for a window of
 * a day or longer, of its time outside the `weekend` (`Date.getDay` numbers,
 * in the page's time zone) alone, so the pace waits while the user does not
 * work; a shorter window, or one with no time outside the weekend, by the
 * calendar (`elapsedShare`). Null with no reset clock.
 */
export function paceShare(
  window: ServerProviderUsageWindow,
  now: number,
  weekend: ReadonlySet<number>,
): number | null {
  const share = elapsedShare(window, now);
  const { resetsAt, windowDurationMins: minutes } = window;
  // A share means both are there.
  if (share === null || resetsAt === undefined || minutes === undefined) return share;
  if (weekend.size === 0 || minutes < DAY_MINUTES) return share;
  const end = Date.parse(resetsAt);
  const start = end - minutes * MINUTE;
  const working = workingMillis(start, end, weekend);
  if (working === 0) return share;
  return workingMillis(start, Math.max(start, Math.min(now, end)), weekend) / working;
}

/** The time from `from` to `to` on days outside the `weekend`, day by day at the page's midnights. */
function workingMillis(from: number, to: number, weekend: ReadonlySet<number>): number {
  let total = 0;
  for (let at = from; at < to;) {
    const day = new Date(at);
    const until = Math.min(
      to,
      new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(),
    );
    if (!weekend.has(day.getDay())) total += until - at;
    at = until;
  }
  return total;
}

/**
 * A window warns past 95% used, or while it is spent more than upstream's
 * five points past even pace (`paceShare`), so it runs out before its reset;
 * one with no reset clock warns on the 95% rule alone.
 */
export function warns(
  window: ServerProviderUsageWindow,
  now: number,
  weekend: ReadonlySet<number>,
): boolean {
  if (window.usedPercent > WARNING_USED_PERCENT) return true;
  const share = paceShare(window, now, weekend);
  return share !== null && window.usedPercent - share * 100 > PACE_TOLERANCE_PERCENT;
}

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
 * shows. An account shows while it has a window to show. The pace counts
 * no time on the `weekend` (`paceShare`).
 */
export function limitsShelf<Account extends AccountRef>(
  accounts: ReadonlyArray<Account>,
  now: number,
  showAll: boolean,
  weekend: ReadonlySet<number>,
): LimitsShelf<Account> | null {
  const all = accounts
    .map((account) => ({
      account,
      windows: account.limits.windows
        .filter(showsWindow)
        .map((window) => ({ window, warning: warns(window, now, weekend) })),
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
