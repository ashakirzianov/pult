import {
  getService,
  ICommandService,
  IContextKeyService,
  IPaneCompositePartService,
  IStorageService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import {
  Direction,
  type Grid,
  type IView,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import {
  StorageScope,
  StorageTarget,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { updateOffer } from "../desktop/updates.ts";
import { allowNativeScroll } from "../nativeScroll.ts";
import { PANEL_ID } from "./explorer.ts";
import { panelTabStore, PanelTabs, type PanelTabStore } from "./PanelTabs.tsx";
import { TrayShelves } from "./TrayShelves.tsx";

/** The tray's height, the sidebar's title's, and the thread view's bar's (`--pult-bar-height`), so their icons share a line. */
const ROW_HEIGHT = 35;
/** On the sidebar part while the header stands in its title, the Pult tab's. */
const HEADER_IN_TITLE = "pult-header-in-title";

/** The layout's grid and the sidebar part's view, which the layout keeps to itself (as `src/status/index.tsx` reads them). */
interface LayoutGrid {
  readonly workbenchGrid: Grid<IView>;
  readonly sideBarPartView: IView;
}

/** The tray as a view of the workbench's grid: a fixed height, any width, so the sidebar's column keeps its own. */
function rowView(className: string): IView {
  const element = document.createElement("div");
  element.className = className;
  return {
    element,
    minimumWidth: 0,
    maximumWidth: Number.POSITIVE_INFINITY,
    minimumHeight: ROW_HEIGHT,
    maximumHeight: ROW_HEIGHT,
    onDidChange: Event.None,
    layout: () => {},
  };
}

const run = (command: string) => () =>
  void getService(ICommandService).then((commands) => commands.executeCommand(command));

/** A row's icon button, running `command`, or with `menu` showing it under the button. */
function RowButton({
  title,
  icon,
  ...does
}: { title: string; icon: string } & (
  | { command: string }
  | { menu: (anchor: HTMLElement) => Promise<void> }
)) {
  return (
    <button
      type="button"
      className="pult-panel-row-button"
      title={title}
      aria-label={title}
      aria-haspopup={"menu" in does ? "menu" : undefined}
      onClick={"menu" in does ? (event) => void does.menu(event.currentTarget) : run(does.command)}
    >
      <i className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

/** The header sits before the active tab's native toolbar. In VS Code mode only Pult uses it. */
function PanelHeader({ store }: { store: PanelTabStore }) {
  const tabs = useSyncExternalStore(store.subscribe, store.get);
  return (
    <>
      <span className="pult-panel-header-lights" />
      <span className="pult-vscode-collapse">
        <RowButton
          title="Collapse Panel"
          icon="layout-sidebar-left"
          command="pult-shell.collapsePanel"
        />
      </span>
      <PanelTabs store={store} />
      <span className="pult-panel-row-spacer" />
      {tabs.some((tab) => tab.active && tab.id === PANEL_ID) && (
        <RowButton title="New" icon="add" menu={showNewMenu} />
      )}
    </>
  );
}

/** The header's New menu under `anchor`: New Thread and New Star, the palette's New Thread and Create Star, the latter while the palette offers it. */
async function showNewMenu(anchor: HTMLElement): Promise<void> {
  const [menus, commands, contextKeys] = await Promise.all([
    getService(IContextMenuService),
    getService(ICommandService),
    getService(IContextKeyService),
  ]);
  const entry = (id: string, label: string, enabled = true) =>
    toAction({ id, label, enabled, run: () => commands.executeCommand(id) });
  menus.showContextMenu({
    getAnchor: () => anchor,
    getActions: () => [
      entry("pult-shell.newThread", "New Thread"),
      entry(
        "pult-shell.createStar",
        "New Star",
        contextKeys.getContextKeyValue("pult.canCreateStar") === true,
      ),
    ],
  });
}

/** The tray's update button in Pult.app (`updateOffer`), an icon its tooltip names: Download for an update found, a spinner while it downloads, then Restart to Update. */
function UpdateButton() {
  const offer = useSyncExternalStore(updateOffer.subscribe, updateOffer.get);
  if (offer === null) return null;
  const { icon, title } = {
    download: { icon: "cloud-download", title: `Download Pult ${offer.version}` },
    downloading: {
      icon: "loading codicon-modifier-spin",
      title: `Downloading Pult ${offer.version}`,
    },
    restart: { icon: "debug-restart", title: `Restart Pult to install ${offer.version}` },
  }[offer.kind];
  return (
    <button
      type="button"
      className="pult-panel-row-button pult-panel-update"
      title={title}
      aria-label={title}
      disabled={offer.kind === "downloading"}
      onClick={() => void updateOffer.act()}
    >
      <i className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

/**
 * The left panel's bottom row, the tray: every icon in it is something not
 * showing, which a click shows. The closed shelves' icons at
 * its left end (`TrayShelves.tsx`), then in Pult.app the update's button while there is
 * one, Collapse Panel in Pult mode or the tabs in VS Code mode, and
 * rightmost the gear, which opens the Pult settings page.
 */
function Tray({ store }: { store: PanelTabStore }) {
  return (
    <>
      <TrayShelves />
      <span className="pult-panel-row-spacer" />
      <UpdateButton />
      <span className="pult-tray-collapse">
        <RowButton
          title="Collapse Panel"
          icon="layout-sidebar-left"
          command="pult-shell.collapsePanel"
        />
      </span>
      <PanelTabs store={store} />
      <RowButton title="Settings" icon="settings-gear" command="pult-shell.selectSettings" />
    </>
  );
}

/**
 * The sidebar's title hosts the header, reusing the active container's native toolbar.
 * The tray is a separate grid view, hidden with the sidebar. Expand Panel appears over
 * the top-left editor group's tabs while the sidebar is collapsed. Its width and
 * visibility are saved so it reopens as left.
 */
export async function startPanelRows(): Promise<void> {
  const [layout, panes, storage] = await Promise.all([
    getService(IWorkbenchLayoutService),
    getService(IPaneCompositePartService),
    getService(IStorageService),
  ]);
  const { workbenchGrid, sideBarPartView } = layout as unknown as Partial<LayoutGrid>;
  const title = sideBarPartView?.element.querySelector<HTMLElement>(":scope > .composite.title");
  if (
    workbenchGrid === undefined ||
    sideBarPartView === undefined ||
    title === null ||
    title === undefined
  )
    return;

  const store = await panelTabStore();
  const header = document.createElement("div");
  header.className = "pult-panel-header";
  title.prepend(header);
  allowNativeScroll(title);
  createRoot(header).render(<PanelHeader store={store} />);
  // Ahead of the part's own listener on the title, which opens the menu.
  title.addEventListener(
    "contextmenu",
    (event) => {
      if (title.closest(".pult-mode-vscode") !== null) return;
      event.preventDefault();
      event.stopPropagation();
    },
    { capture: true },
  );

  const tray = rowView("pult-panel-tray");
  workbenchGrid.addView(tray, ROW_HEIGHT, sideBarPartView, Direction.Down);
  createRoot(tray.element).render(<Tray store={store} />);

  const expand = document.createElement("div");
  expand.className = "pult-panel-expand";
  layout.mainContainer.append(expand);
  createRoot(expand).render(
    <RowButton
      title="Expand Panel"
      icon="layout-sidebar-left-off"
      command="pult-shell.expandPanel"
    />,
  );

  const follow = () => {
    sideBarPartView.element.classList.toggle(
      HEADER_IN_TITLE,
      panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === PANEL_ID,
    );
    workbenchGrid.setViewVisible(tray, layout.isVisible(Parts.SIDEBAR_PART));
  };
  const expandToWidth = keepPanelWidth(layout, storage, sideBarPartView);
  layout.onDidChangePartVisibility((event) => {
    if (event.partId !== Parts.SIDEBAR_PART) return;
    follow();
    if (event.visible) expandToWidth();
    // The layout stores the part's visibility only when the workbench saves its state (at intervals, and at shutdown,
    // which a page's close or reload may not finish): saved now, the next start shows the panel as it was left.
    void storage.flush();
  });
  panes.onDidPaneCompositeOpen(follow);
  panes.onDidPaneCompositeClose(follow);
  follow();
}

/**
 * The panel's width while it is collapsed. The tray puts the sidebar
 * part in a column of the grid, so the layout saves a collapsed part's
 * cached size along that column, its height, as its width, and a panel
 * collapsed at start loses its width to the tray's `addView`. The last width
 * the panel showed at is kept here, saved in the layout's place while
 * collapsed, and applied by the returned function on expanding; a saved
 * width over half the window, the layout's own mistake, gives way to the
 * layout's default.
 */
function keepPanelWidth(
  layout: IWorkbenchLayoutService,
  storage: IStorageService,
  sideBarPartView: IView,
): () => void {
  // The layout's own key for the part's width (`LayoutStateKeys.SIDEBAR_SIZE`).
  const key = "workbench.sideBar.size";
  const containerWidth = layout.mainContainerDimension.width;
  const saved = storage.getNumber(key, StorageScope.PROFILE);
  let width =
    saved !== undefined && saved <= containerWidth / 2 ? saved : Math.min(300, containerWidth / 4);
  new ResizeObserver(() => {
    if (layout.isVisible(Parts.SIDEBAR_PART) && sideBarPartView.element.offsetWidth > 0)
      width = sideBarPartView.element.offsetWidth;
  }).observe(sideBarPartView.element);
  // After the layout's own listener, registered as the workbench started.
  storage.onWillSaveState(() => {
    if (!layout.isVisible(Parts.SIDEBAR_PART))
      storage.store(key, width, StorageScope.PROFILE, StorageTarget.MACHINE);
  });
  return () =>
    layout.setSize(Parts.SIDEBAR_PART, {
      width,
      height: layout.getSize(Parts.SIDEBAR_PART).height,
    });
}
