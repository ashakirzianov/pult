import {
  getService,
  IActivityService,
  ICommandService,
  IPaneCompositePartService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
} from "@codingame/monaco-vscode-api";
import { DisposableStore } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { FileAccess } from "@codingame/monaco-vscode-api/vscode/vs/base/common/network";
import { ThemeIcon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/themables";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  MenuId,
  MenuRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { StorageScope } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { NumberBadge } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/activity/common/activity";
import { useEffect, useSyncExternalStore } from "react";

import { modeChoice, VSCodeModeContext } from "../mode.ts";
import { fitTabs } from "./fitTabs.ts";

/** The stock activity bar's pins, which it keeps while shown, the user's own: unset, every tab is pinned, Search and Extensions too, and the mode leaves them alone. */
const PINNED_KEY = "workbench.activity.pinnedViewlets2";
/** Source Control's tab, which opens on every checkout's changes, whatever filter the changes view had (`src/changes/`). */
const SCM_CONTAINER = "workbench.view.scm";

/**
 * The sidebar tabs Pult mode hides until they are designed (xaxis
 * `pult/tasks/search-tab.task`, `pult/tasks/extensions-tab.task`), each with
 * the palette's commands into it, which Pult mode hides too: no tab in the
 * header, and opened any other way (a key, the settings page's Manage menu,
 * an extension's command), the Pult tab instead (`view.tsx`). VS Code mode
 * shows them. Remove an entry to bring its tab back.
 */
export const UNDESIGNED_TABS = new Map<string, (command: string) => boolean>([
  [
    "workbench.view.search",
    (command) =>
      [
        "workbench.view.search",
        "workbench.view.search.focus",
        "workbench.action.findInFiles",
        "workbench.action.replaceInFiles",
      ].includes(command),
  ],
  [
    "workbench.view.extensions",
    (command) =>
      [
        "workbench.view.extensions",
        "workbench.extensions.action.focusExtensionsView",
        "workbench.extensions.action.installExtensions",
        "workbench.extensions.action.installedExtensions",
        "workbench.extensions.action.listBuiltInExtensions",
        "workbench.extensions.action.recentlyPublishedExtensions",
        "workbench.extensions.action.extensionUpdates",
      ].includes(command) ||
      command.startsWith("workbench.extensions.action.show") ||
      command.startsWith("extensions.filter."),
  ],
]);

interface PanelTab {
  readonly id: string;
  readonly title: string;
  /** A codicon's class names, or an image the tab's colour masks. */
  readonly icon: { readonly className: string } | { readonly url: string } | undefined;
  readonly active: boolean;
  readonly badge: number | undefined;
}

/**
 * The sidebar's view containers as the left panel lists them:
 * those the stock activity bar would show (a container that is not hidden when
 * empty, Extensions among them, or one with a view to show), the user's
 * unpinned ones left out unless open, and in Pult mode `UNDESIGNED_TABS`,
 * in their order, each with its title, icon, whether it is open and its
 * number badge (Source Control's count). Any container counts, an
 * extension's as much as VS Code's, as the stock activity bar would list it.
 * A store, read again on any change of the containers, their views, the
 * open one or the badges.
 */
export async function panelTabStore() {
  const [views, viewsService, panes, activities, storage, commands, mode] = await Promise.all([
    getService(IViewDescriptorService),
    getService(IViewsService),
    getService(IPaneCompositePartService),
    getService(IActivityService),
    getService(IStorageService),
    getService(ICommandService),
    modeChoice(),
  ]);

  const read = (): PanelTab[] => {
    const active = panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
    const pultMode = mode.current() === "pult";
    const stored = new Map<string, { pinned?: boolean; order?: number }>();
    try {
      for (const entry of JSON.parse(storage.get(PINNED_KEY, StorageScope.PROFILE) ?? "[]") as {
        id: string;
        pinned?: boolean;
        order?: number;
      }[]) {
        stored.set(entry.id, entry);
      }
    } catch {
      // An unreadable pin list pins everything, as a fresh profile has it.
    }
    const order = (container: { id: string; order?: number }) =>
      stored.get(container.id)?.order ?? container.order ?? Number.MAX_SAFE_INTEGER;
    return views
      .getViewContainersByLocation(ViewContainerLocation.Sidebar)
      .map((container, index) => ({
        container,
        index,
        model: views.getViewContainerModel(container),
      }))
      .filter(
        ({ container }) =>
          viewsService.isViewContainerActive(container.id) &&
          !(pultMode && UNDESIGNED_TABS.has(container.id)) &&
          (stored.get(container.id)?.pinned !== false || container.id === active),
      )
      .sort((a, b) => order(a.container) - order(b.container) || a.index - b.index)
      .map(({ container, model }) => {
        const icon = model.icon;
        const badge = activities
          .getViewContainerActivities(container.id)
          .find((activity) => activity.badge instanceof NumberBadge)?.badge;
        return {
          id: container.id,
          title: model.title,
          icon: ThemeIcon.isThemeIcon(icon)
            ? { className: ThemeIcon.asClassName(icon) }
            : URI.isUri(icon)
              ? { url: FileAccess.uriToBrowserUri(icon).toString(true) }
              : undefined,
          active: container.id === active,
          badge: badge instanceof NumberBadge && badge.number > 0 ? badge.number : undefined,
        };
      });
  };

  const listeners = new Set<() => void>();
  let tabs = read();
  const refresh = () => {
    tabs = read();
    for (const listener of listeners) listener();
  };
  const models = new DisposableStore();
  const watchContainers = () => {
    models.clear();
    for (const container of views.getViewContainersByLocation(ViewContainerLocation.Sidebar)) {
      const model = views.getViewContainerModel(container);
      models.add(model.onDidChangeActiveViewDescriptors(refresh));
      models.add(model.onDidChangeContainerInfo(refresh));
    }
    refresh();
  };
  watchContainers();
  views.onDidChangeViewContainers(watchContainers);
  views.onDidChangeContainerLocation(watchContainers);
  panes.onDidPaneCompositeOpen(refresh);
  panes.onDidPaneCompositeClose(refresh);
  activities.onDidChangeActivity(refresh);
  mode.onDidChange(refresh);
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => tabs,
    open: (id: string) =>
      void (id === SCM_CONTAINER
        ? commands.executeCommand("pult-shell.showAllChanges")
        : panes.openPaneComposite(id, ViewContainerLocation.Sidebar, true)),
  };
}

export type PanelTabStore = Awaited<ReturnType<typeof panelTabStore>>;

/** The room the header gives its tabs and each one's width with its gap, measured (`rows.tsx`). */
export interface TabFit {
  readonly room: number;
  readonly step: number;
}

/**
 * Panel tabs in Pult's header or, in VS Code mode, in the tray. Source Control
 * opens on all checkouts. Given a `fit`, those that do not fit go under the
 * active tab's toolbar's "..." (`fitTabs`, `useOverflowTabs`).
 */
export function PanelTabs({ store, fit }: { store: PanelTabStore; fit?: TabFit }) {
  const tabs = useSyncExternalStore(store.subscribe, store.get);
  const { shown, hidden } =
    fit === undefined ? { shown: tabs, hidden: [] } : fitTabs(tabs, fit.room, fit.step);
  useOverflowTabs(hidden, store);
  return (
    <div className="pult-panel-tabs" role="tablist" aria-label="Panel tabs">
      {shown.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.active}
          aria-label={tab.title}
          title={tab.title}
          data-container={tab.id}
          className={`pult-panel-tab${tab.active ? " pult-panel-tab-active" : ""}`}
          onClick={() => store.open(tab.id)}
        >
          {tab.icon === undefined ? (
            <span className="pult-panel-tab-label">{tab.title}</span>
          ) : "className" in tab.icon ? (
            <i className={tab.icon.className} aria-hidden />
          ) : (
            <i
              className="pult-panel-tab-image"
              style={{ maskImage: `url("${tab.icon.url}")` }}
              aria-hidden
            />
          )}
          {tab.badge === undefined ? null : (
            <span className="pult-panel-tab-badge">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The tabs that do not fit, as a group of the menu under the sidebar title
 * toolbar's "...", after the actions that do not fit: one "..." for the
 * header, the workbench's own (`responsiveSidebarToolbar`, `view.tsx`). Each
 * entry carries its tab's badge's count.
 */
function useOverflowTabs(hidden: readonly PanelTab[], store: PanelTabStore) {
  const entries = hidden.map(
    (tab) => [tab.id, tab.badge === undefined ? tab.title : `${tab.title} (${tab.badge})`] as const,
  );
  const key = JSON.stringify(entries);
  useEffect(() => {
    const items = (JSON.parse(key) as [string, string][]).map(([id, title], order) => {
      const command = `pult-shell.openPanelTab.${id}`;
      if (CommandsRegistry.getCommand(command) === undefined)
        CommandsRegistry.registerCommand(command, () => store.open(id));
      return {
        id: MenuId.ViewContainerTitle,
        item: {
          command: { id: command, title },
          group: "0_pult_tabs",
          order,
          when: ContextKeyExpr.and(
            ContextKeyExpr.equals("viewContainerLocation", "sidebar"),
            VSCodeModeContext.toNegated(),
          ),
        },
      };
    });
    const registered = MenuRegistry.appendMenuItems(items);
    return () => registered.dispose();
  }, [key, store]);
}
