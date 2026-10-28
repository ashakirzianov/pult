import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { type IAction, Separator, SubmenuAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { type IMenu, MenuId } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import type { IMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions.service";
import type { IContextKeyService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey.service";
import { useEffect, useState, useSyncExternalStore } from "react";

import { connection, environmentName, type ShellEnvironment } from "../connection/index.ts";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The Pult settings page, the Settings selection's leftmost tab
 * (`pane.tsx`): Pult's own settings first, then the workbench's Manage
 * menu, whose editors open beside the page in the Settings tab set.
 */
export function SettingsPage({ menus, contextKeys }: { menus: IMenuService; contextKeys: IContextKeyService }) {
  return (
    <div className="pult-settings">
      <h1 className="pult-settings-title">Settings</h1>
      <EnvironmentsSection />
      {/* Appearance (xaxis `pult/color-scheme-setting`) goes here, between Environments and VS Code. */}
      <VSCodeSection menus={menus} contextKeys={contextKeys} />
    </div>
  );
}

const PHASES: Record<ShellEnvironment["phase"], string> = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  blocked: "Blocked",
};

/**
 * Every environment the page holds, in the order they were connected, each
 * with its server's host, how its connection stands and why when it is not
 * ready, and Disconnect, and Retry while it is not ready; then Connect to
 * Environment, which adds one. The palette's Pult: Connect to Environment,
 * Disconnect and Retry Connection are the same commands.
 */
function EnvironmentsSection() {
  const environments = useSyncExternalStore(
    (listener) => connection.onDidChange(listener),
    () => connection.environments,
  );
  return (
    <section className="pult-settings-section">
      <h2>Environments</h2>
      {environments.length === 0 ? (
        <p className="pult-settings-note">Pult is not connected to an environment.</p>
      ) : (
        <ul className="pult-settings-rows">
          {environments.map((environment) => (
            <li key={environment.environmentId} className="pult-settings-row">
              <div className="pult-settings-row-text">
                <div className="pult-settings-row-label">{environmentName(environment, environments)}</div>
                <div className="pult-settings-row-description">
                  {[hostOf(environment), PHASES[environment.phase]].filter((part) => part !== undefined).join(" · ")}
                </div>
                {environment.error === null ? null : <div className="pult-settings-row-error">{environment.error}</div>}
              </div>
              <div className="pult-settings-row-actions">
                {environment.phase === "ready" ? null : (
                  <button
                    type="button"
                    className="pult-settings-button"
                    onClick={() => run("pult-shell.retryConnection", environment.environmentId)}
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  className="pult-settings-button"
                  onClick={() => run("pult-shell.disconnect", environment.environmentId)}
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="pult-settings-button pult-settings-button-primary" onClick={() => run("pult-shell.connect")}>
        Connect to Environment
      </button>
    </section>
  );
}

function hostOf(environment: ShellEnvironment): string | undefined {
  return URL.canParse(environment.httpBaseUrl) ? new URL(environment.httpBaseUrl).host : undefined;
}

/** The stock Settings command, routed to this page (`src/threads/selection.ts`), and the settings editor it would open. */
const OPEN_SETTINGS = "workbench.action.openSettings";
const OPEN_SETTINGS_EDITOR = "workbench.action.openSettings2";

type MenuGroups = ReturnType<IMenu["getActions"]>;

/**
 * The workbench's Manage menu (the activity bar's gear,
 * `MenuId.GlobalActivity`), live from the menu service, in its groups and
 * following its changes: in this build the Command Palette; Profiles,
 * Settings, Extensions, Keyboard Shortcuts, Snippets, Themes and, while the
 * modern UI is on, Layout Density; and the update entries, when there are
 * any. A submenu is a nested list, one level deep. The menu's Settings is
 * this page, so its entry here opens VS Code's settings editor instead.
 */
function VSCodeSection({ menus, contextKeys }: { menus: IMenuService; contextKeys: IContextKeyService }) {
  const [groups, setGroups] = useState<MenuGroups>([]);
  useEffect(() => {
    const menu = menus.createMenu(MenuId.GlobalActivity, contextKeys, { emitEventsForSubmenuChanges: true });
    const read = () => setGroups(menu.getActions({ renderShortTitle: true }));
    const listener = menu.onDidChange(read);
    read();
    return () => {
      listener.dispose();
      menu.dispose();
    };
  }, [menus, contextKeys]);
  return (
    <section className="pult-settings-section">
      <h2>VS Code</h2>
      {groups.map(([group, actions]) => (
        <ul key={group} className="pult-settings-entries">
          {actions.map((action) => (
            <li key={action.id}>
              {action instanceof SubmenuAction ? <Submenu submenu={action} /> : <Entry action={action} />}
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

/** A submenu's label, then its entries, its groups apart as the menu's separators set them; a deeper submenu's entries join its own. */
function Submenu({ submenu }: { submenu: SubmenuAction }) {
  const groups = [[]] as IAction[][];
  const collect = (actions: readonly IAction[]) => {
    for (const action of actions) {
      if (action instanceof Separator) groups.push([]);
      else if (action instanceof SubmenuAction) collect(action.actions);
      else groups[groups.length - 1].push(action);
    }
  };
  collect(submenu.actions);
  return (
    <div className="pult-settings-submenu">
      <div className="pult-settings-submenu-label">{submenu.label}</div>
      {groups
        .filter((actions) => actions.length > 0)
        .map((actions, index) => (
          <ul key={index} className="pult-settings-entries">
            {actions.map((action) => (
              <li key={action.id}>
                <Entry action={action} />
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

/** One of the menu's entries, a button with its label running it; a toggle (a profile, a layout density) shows a check while it is on. */
function Entry({ action }: { action: IAction }) {
  const settings = action.id === OPEN_SETTINGS;
  return (
    <button
      type="button"
      className="pult-settings-entry"
      disabled={!action.enabled}
      aria-pressed={action.checked}
      onClick={() => (settings ? run(OPEN_SETTINGS_EDITOR) : void action.run())}
    >
      {action.checked === undefined ? null : (
        <span className={`codicon ${action.checked ? "codicon-check" : "codicon-blank"}`} aria-hidden />
      )}
      {action.label}
    </button>
  );
}
