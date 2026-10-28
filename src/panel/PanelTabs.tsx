import { getService, IActivityService, IPaneCompositePartService, IStorageService, IViewDescriptorService } from "@codingame/monaco-vscode-api";
import { DisposableStore } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { FileAccess } from "@codingame/monaco-vscode-api/vscode/vs/base/common/network";
import { ThemeIcon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/themables";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { StorageScope } from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { NumberBadge } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/activity/common/activity";
import { useSyncExternalStore } from "react";

/** The stock activity bar's pins, which it keeps while shown; Search and Extensions are unpinned by default (`src/services.ts`). */
const PINNED_KEY = "workbench.activity.pinnedViewlets2";

interface PanelTab {
  readonly id: string;
  readonly title: string;
  /** A codicon's class names, or an image the tab's colour masks. */
  readonly icon: { readonly className: string } | { readonly url: string } | undefined;
  readonly active: boolean;
  readonly badge: number | undefined;
}

/**
 * The sidebar's view containers as the left panel's bottom row lists them:
 * those with a view to show, the user's unpinned ones left out unless open,
 * in their order, each with its title, icon, whether it is open and its
 * number badge (Source Control's count). Any container counts, an
 * extension's as much as VS Code's, as the stock activity bar would list it.
 * A store, read again on any change of the containers, their views, the
 * open one or the badges.
 */
export async function panelTabStore() {
  const [views, panes, activities, storage] = await Promise.all([
    getService(IViewDescriptorService),
    getService(IPaneCompositePartService),
    getService(IActivityService),
    getService(IStorageService),
  ]);

  const read = (): PanelTab[] => {
    const active = panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
    const stored = new Map<string, { pinned?: boolean; order?: number }>();
    try {
      for (const entry of JSON.parse(storage.get(PINNED_KEY, StorageScope.PROFILE) ?? "[]") as { id: string; pinned?: boolean; order?: number }[]) {
        stored.set(entry.id, entry);
      }
    } catch {
      // An unreadable pin list pins everything, as a fresh profile has it.
    }
    const order = (container: { id: string; order?: number }) =>
      stored.get(container.id)?.order ?? container.order ?? Number.MAX_SAFE_INTEGER;
    return views
      .getViewContainersByLocation(ViewContainerLocation.Sidebar)
      .map((container, index) => ({ container, index, model: views.getViewContainerModel(container) }))
      .filter(({ container, model }) => model.activeViewDescriptors.length > 0 && (stored.get(container.id)?.pinned !== false || container.id === active))
      .sort((a, b) => order(a.container) - order(b.container) || a.index - b.index)
      .map(({ container, model }) => {
        const icon = model.icon;
        const badge = activities.getViewContainerActivities(container.id).find((activity) => activity.badge instanceof NumberBadge)?.badge;
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
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => tabs,
    open: (id: string) => void panes.openPaneComposite(id, ViewContainerLocation.Sidebar, true),
  };
}

export type PanelTabStore = Awaited<ReturnType<typeof panelTabStore>>;

/**
 * The left panel's tabs, in its bottom row: a button per sidebar tab, the
 * open one on the background the others take on hover, in place of VS
 * Code's activity bar, which the shell hides
 * (`workbench.activityBar.location`), since at the sidebar's top or bottom
 * it brings the workbench's title bar with it. In Pult's mode the Pult tab
 * has no button (`style.css`): every other tab's Close goes back to it.
 */
export function PanelTabs({ store }: { store: PanelTabStore }) {
  const tabs = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div className="pult-panel-tabs" role="tablist" aria-label="Panel tabs">
      {tabs.map((tab) => (
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
            <i className="pult-panel-tab-image" style={{ maskImage: `url("${tab.icon.url}")` }} aria-hidden />
          )}
          {tab.badge === undefined ? null : <span className="pult-panel-tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}
