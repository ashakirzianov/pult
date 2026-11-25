import {
  getService,
  ICommandService,
  IPaneCompositePartService,
  IStorageService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import {
  Direction,
  type Grid,
  type IView,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import {
  StorageScope,
  StorageTarget,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { updateOffer } from "../desktop/updates.ts";
import { PANEL_ID } from "./explorer.ts";
import { panelTabStore, PanelTabs, type PanelTabStore, type TabFit } from "./PanelTabs.tsx";
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

/** A row's icon button, running `command`. */
function RowButton({ title, icon, command }: { title: string; icon: string; command: string }) {
  return (
    <button
      type="button"
      className="pult-panel-row-button"
      title={title}
      aria-label={title}
      onClick={run(command)}
    >
      <i className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

/**
 * The header, before the active tab's toolbar in the sidebar's title: room
 * for the traffic lights, Collapse Panel where Expand Panel sits while the
 * panel is collapsed, then in Pult mode the tabs, as many as fit (`useTabFit`).
 * In VS Code mode only the Pult tab shows it.
 */
function PanelHeader({
  store,
  header,
  title,
}: {
  store: PanelTabStore;
  header: HTMLElement;
  title: HTMLElement;
}) {
  return (
    <>
      <span className="pult-panel-header-lights" />
      <RowButton
        title="Collapse Panel"
        icon="layout-sidebar-left"
        command="pult-shell.collapsePanel"
      />
      <PanelTabs store={store} fit={useTabFit(header, title)} />
    </>
  );
}

/**
 * The room the header's tabs have: the title's width less the header's other
 * parts and the narrowest the active tab's toolbar goes, the min-width its
 * responsive toolbar keeps for its "..." (`responsiveSidebarToolbar`,
 * `view.tsx`), so the tabs fit first and the toolbar's actions overflow
 * first. Measured again as the title or the header resizes and as the
 * toolbar's actions change.
 */
function useTabFit(header: HTMLElement, title: HTMLElement): TabFit | undefined {
  const [fit, setFit] = useState<TabFit>();
  useEffect(() => {
    const actions = title.querySelector<HTMLElement>(":scope > .title-actions");
    const measure = () => {
      const tabs = header.querySelector<HTMLElement>(":scope > .pult-panel-tabs");
      const tab = tabs?.querySelector<HTMLElement>(".pult-panel-tab");
      if (tabs == null || tab == null) return;
      const titleStyle = getComputedStyle(title);
      const room =
        title.clientWidth -
        parseFloat(titleStyle.paddingLeft) -
        parseFloat(titleStyle.paddingRight) -
        (header.offsetWidth - tabs.offsetWidth) -
        (parseFloat(actions?.style.minWidth ?? "") || 0);
      const step = tab.offsetWidth + parseFloat(getComputedStyle(tabs).columnGap);
      setFit((last) => (last?.room === room && last.step === step ? last : { room, step }));
    };
    const resizes = new ResizeObserver(measure);
    resizes.observe(title);
    resizes.observe(header);
    const toolbar = new MutationObserver(measure);
    if (actions !== null) toolbar.observe(actions, { attributeFilter: ["style"] });
    measure();
    return () => {
      resizes.disconnect();
      toolbar.disconnect();
    };
  }, [header, title]);
  return fit;
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
 * one, in VS Code mode the tabs, and rightmost the gear, which opens the
 * Pult settings page.
 */
function Tray({ store }: { store: PanelTabStore }) {
  return (
    <>
      <TrayShelves />
      <span className="pult-panel-row-spacer" />
      <UpdateButton />
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
  createRoot(header).render(<PanelHeader store={store} header={header} title={title} />);
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
  // First, so Tab reaches it where it sits, at the window's top-left.
  layout.mainContainer.prepend(expand);
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
