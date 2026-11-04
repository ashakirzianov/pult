import { getService } from "@codingame/monaco-vscode-api";
import { Separator, toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { elapsedShare, formatResetsIn, type LimitAccount } from "@t3tools/shared/usageLimits";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { hasUsageProviderIcon, UsageProviderIcon, usageProvider } from "../../thread-view/shell/usageProviders.tsx";
import { setUsageLimitsMode, USAGE_LIMITS_MODES, usageLimitsMode } from "../limits/index.ts";
import { limitsShelf, type ShelfWindow } from "../limits/limits.ts";
import { type LimitsState, limitsStore, refreshLimits } from "../limits/model.ts";
import { limitsShelfState, setLimitsExpanded, setLimitsShowAll } from "../limits/shelf.ts";
import { CollapsibleHeader } from "./collapsible.tsx";
import { EnvironmentChip } from "./DraftCard.tsx";

/** The reveals of the shelf already brought into view, so a remount does not scroll to it again. */
let revealed = 0;

/**
 * The Limits shelf, the Pult tab's last (xaxis `pult/issues/provider-limits-page`):
 * the provider accounts' usage windows with something spent, under a
 * collapsible header with the count of warning windows, in the warning
 * colour while any warns; in `pult.panel.usageLimits`'s `warn` mode the
 * warning windows alone, with Show all, and gone while none warns
 * (`limitsShelf`). Refresh is the header's hover action, its tooltip when
 * each environment's limits were last checked and the notices, its
 * right-click the modes. The rows are no jump targets and do nothing on
 * click. `now` is the panel's minute clock, which the pace moves with.
 */
export function LimitsShelf({ now }: { now: number }) {
  const limits = useSyncExternalStore(limitsStore.subscribe, limitsStore.get);
  const mode = useSyncExternalStore(usageLimitsMode.subscribe, usageLimitsMode.get);
  const view = useSyncExternalStore(limitsShelfState.subscribe, limitsShelfState.get);
  const element = useRef<HTMLLIElement>(null);
  const shelf = limitsShelf(limits.accounts, now, mode, view.showAll);
  useEffect(() => {
    if (shelf === null || view.reveals === revealed) return;
    revealed = view.reveals;
    element.current?.scrollIntoView({ block: "nearest" });
  });
  if (shelf === null) return null;
  const several = limits.checks.length > 1;
  return (
    <li ref={element} className={`pult-shelf pult-shelf-limits${shelf.warnings > 0 ? " pult-shelf-limits-warning" : ""}`}>
      <div className="pult-limits-header">
        <CollapsibleHeader
          label="Limits"
          count={shelf.warnings}
          expanded={view.expanded}
          onToggle={() => setLimitsExpanded(!view.expanded)}
          title={headerTooltip(limits, now)}
          onContextMenu={(event) => {
            event.preventDefault();
            void showModeMenu({ x: event.clientX, y: event.clientY });
          }}
        />
        <button
          type="button"
          className="pult-limits-refresh"
          title="Refresh Usage Limits"
          aria-label="Refresh usage limits"
          disabled={limits.refreshing}
          onClick={() => void refreshLimits()}
        >
          <i className={`codicon codicon-refresh${limits.refreshing ? " codicon-modifier-spin" : ""}`} aria-hidden />
        </button>
      </div>
      {view.expanded ? (
        <ul className="pult-shelf-cards pult-limits">
          {shelf.accounts.map(({ account, windows }) => (
            <AccountRows key={account.key} account={account} windows={windows} several={several} now={now} />
          ))}
          {shelf.toggle === null ? null : (
            <li className="pult-shelf-more">
              <button type="button" className="pult-panel-button" onClick={() => setLimitsShowAll(shelf.toggle === "all")}>
                {shelf.toggle === "all" ? "Show all" : "Show less"}
              </button>
            </li>
          )}
        </ul>
      ) : null}
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
          <span className="pult-limits-provider-icon" title={providerName} aria-label={providerName}>
            <UsageProviderIcon driver={account.driver} />
          </span>
        ) : (
          <span className="pult-limits-provider" title={providerName} aria-label={providerName} />
        )}
        <span className="pult-limits-name">{account.displayName ?? account.email ?? providerName}</span>
        {account.plan === undefined ? null : <span className="pult-limits-plan">{account.plan}</span>}
        {several ? account.environments.map((environment) => <EnvironmentChip key={environment.environmentId} label={environment.label} />) : null}
        {account.sourceLabel === null ? null : <EnvironmentChip label={account.sourceLabel} />}
      </div>
      <ul className="pult-limits-windows">
        {windows.map(({ window, warning }) => {
          const used = Math.round(window.usedPercent);
          const resets = formatResetsIn(window, now);
          const pace = elapsedShare(window, now);
          const text = [window.label, `${used}%`, resets === null ? null : resets.charAt(0).toLowerCase() + resets.slice(1)]
            .filter((part) => part !== null)
            .join(" · ");
          return (
            <li key={window.id} className={`pult-limits-window${warning ? " pult-limits-window-warning" : ""}`}>
              <span className="pult-limits-window-text">{text}</span>
              <span className="pult-limits-bar" aria-hidden>
                <span className="pult-limits-bar-used" style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
                {pace === null ? null : <span className="pult-limits-bar-pace" style={{ left: `${pace * 100}%` }} />}
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

/** The header's right-click: the shelf's modes, the current one checked, then Refresh. */
async function showModeMenu(anchor: { x: number; y: number }): Promise<void> {
  const menus = await getService(IContextMenuService);
  const current = usageLimitsMode.get();
  menus.showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      ...USAGE_LIMITS_MODES.map(({ mode, label }) =>
        toAction({ id: `pult-shell.usageLimits.${mode}`, label, checked: mode === current, run: () => setUsageLimitsMode(mode) }),
      ),
      new Separator(),
      toAction({ id: "pult-shell.refreshUsageLimits", label: "Refresh Usage Limits", run: () => refreshLimits() }),
    ],
  });
}
