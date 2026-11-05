import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { elapsedShare, formatResetsIn, type LimitAccount } from "@t3tools/shared/usageLimits";
import { useRef, useSyncExternalStore } from "react";

import {
  hasUsageProviderIcon,
  UsageProviderIcon,
  usageProvider,
} from "../../view/usageProviders.tsx";
import { limitsShelf, type ShelfWindow } from "../limits/limits.ts";
import { type LimitsState, limitsStore, refreshLimits } from "../limits/model.ts";
import { limitsShowAll, setLimitsShowAll } from "../limits/shelf.ts";
import { EnvironmentChip } from "./DraftCard.tsx";
import { closedShelves, closeShelf, ShelfHeader, useReveal } from "./shelves.tsx";

const refreshAction = toAction({
  id: "pult-shell.refreshUsageLimits",
  label: "Refresh Usage Limits",
  run: () => refreshLimits(),
});

/**
 * The Limits shelf, the Pult tab's last (xaxis `pult/issues/provider-limits-page`):
 * the provider accounts' usage windows with something spent, under its
 * header with the count of warning windows while any warns, open until closed, when its icon
 * goes to the tray (`TrayShelves.tsx`); while any warns the warning windows
 * alone, with Show all, else every window with something spent, and gone
 * while none has (`limitsShelf`). Refresh is the header's hover action and in
 * its right-click, its tooltip when each environment's limits were last
 * checked and the notices. The rows are no jump targets and do nothing on
 * click. `now` is the panel's minute clock, which the pace moves with.
 */
export function LimitsShelf({ now }: { now: number }) {
  const limits = useSyncExternalStore(limitsStore.subscribe, limitsStore.get);
  const showAll = useSyncExternalStore(limitsShowAll.subscribe, limitsShowAll.get);
  const closed = useSyncExternalStore(closedShelves.subscribe, closedShelves.get).has("limits");
  const element = useRef<HTMLLIElement>(null);
  useReveal("limits", element);
  const shelf = limitsShelf(limits.accounts, now, showAll);
  if (closed || shelf === null) return null;
  const several = limits.checks.length > 1;
  return (
    <li ref={element} className="pult-shelf pult-shelf-limits">
      <ShelfHeader
        shelf="limits"
        label="Limits"
        count={shelf.warnings > 0 ? shelf.warnings : undefined}
        title={headerTooltip(limits, now)}
        menu={[refreshAction]}
        onClose={() => {
          setLimitsShowAll(false);
          closeShelf("limits");
        }}
        actions={
          <button
            type="button"
            className="pult-shelf-action pult-limits-refresh"
            title="Refresh Usage Limits"
            aria-label="Refresh usage limits"
            disabled={limits.refreshing}
            onClick={() => void refreshLimits()}
          >
            <i
              className={`codicon codicon-refresh${limits.refreshing ? " codicon-modifier-spin" : ""}`}
              aria-hidden
            />
          </button>
        }
      />
      <ul className="pult-shelf-cards pult-limits">
        {shelf.accounts.map(({ account, windows }) => (
          <AccountRows
            key={account.key}
            account={account}
            windows={windows}
            several={several}
            now={now}
          />
        ))}
        {shelf.toggle === null ? null : (
          <li className="pult-shelf-more">
            <button
              type="button"
              className="pult-panel-button"
              onClick={() => setLimitsShowAll(shelf.toggle === "all")}
            >
              {shelf.toggle === "all" ? "Show all" : "Show less"}
            </button>
          </li>
        )}
      </ul>
    </li>
  );
}

/**
 * An account's line, its provider's icon (its colour, for a provider the page
 * has no icon of), its name (its display name, else
 * its email, else the provider's short name), its plan and, while several
 * environments are held, the environments it is logged in on (a hub's
 * account, its hub's name); then a line per window, "Weekly · 84% · resets
 * in 2d 3h", over a bar of the share used with a tick at even pace.
 */
function AccountRows({
  account,
  windows,
  several,
  now,
}: {
  account: LimitAccount;
  windows: ReadonlyArray<ShelfWindow>;
  several: boolean;
  now: number;
}) {
  const provider = usageProvider(account.driver);
  const providerName = provider?.label ?? String(account.driver);
  const color = { "--pult-limit-color": provider?.color } as React.CSSProperties;
  return (
    <li className="pult-limits-account" style={color}>
      <div className="pult-limits-account-top">
        {hasUsageProviderIcon(account.driver) ? (
          <span
            className="pult-limits-provider-icon"
            title={providerName}
            aria-label={providerName}
          >
            <UsageProviderIcon driver={account.driver} />
          </span>
        ) : (
          <span className="pult-limits-provider" title={providerName} aria-label={providerName} />
        )}
        <span className="pult-limits-name">
          {account.displayName ?? account.email ?? providerName}
        </span>
        {account.plan === undefined ? null : (
          <span className="pult-limits-plan">{account.plan}</span>
        )}
        {several
          ? account.environments.map((environment) => (
              <EnvironmentChip key={environment.environmentId} label={environment.label} />
            ))
          : null}
        {account.sourceLabel === null ? null : <EnvironmentChip label={account.sourceLabel} />}
      </div>
      <ul className="pult-limits-windows">
        {windows.map(({ window, warning }) => {
          const used = Math.round(window.usedPercent);
          const resets = formatResetsIn(window, now);
          const pace = elapsedShare(window, now);
          const text = [
            window.label,
            `${used}%`,
            resets === null ? null : resets.charAt(0).toLowerCase() + resets.slice(1),
          ]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li
              key={window.id}
              className={`pult-limits-window${warning ? " pult-limits-window-warning" : ""}`}
            >
              <span className="pult-limits-window-text">{text}</span>
              <span className="pult-limits-bar" aria-hidden>
                <span
                  className="pult-limits-bar-used"
                  style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                />
                {pace === null ? null : (
                  <span className="pult-limits-bar-pace" style={{ left: `${pace * 100}%` }} />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** When each environment's limits were last checked, per environment while several are held, then the notices. */
function headerTooltip(limits: LimitsState, now: number): string {
  const several = limits.checks.length > 1;
  // An environment none of whose providers report limits has no check to name.
  const checks = limits.checks.flatMap(({ name, checkedAt }) => {
    if (checkedAt === null) return [];
    const checked = `checked ${ago(checkedAt, now)}`;
    return [several ? `${name}: ${checked}` : checked.charAt(0).toUpperCase() + checked.slice(1)];
  });
  return [...checks, ...limits.notices].join("\n");
}

/** How long ago `iso` was, as the cards' ages read: "just now", "5m ago", "3h ago", "2d ago". */
function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
