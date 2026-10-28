import { getService, ICommandService, IPaneCompositePartService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { ViewContainerLocation } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/views";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { createRoot } from "react-dom/client";

import logoUrl from "../../assets/pult/logo-color.svg";
import { PANEL_ID } from "./explorer.ts";
import { panelTabStore, PanelTabs, type PanelTabStore } from "./PanelTabs.tsx";

/** The bottom row's height, the sidebar's title's. */
const ROW_HEIGHT = 35;
/** On the sidebar part while the header stands in its title, the Pult tab's. */
const HEADER_IN_TITLE = "pult-header-in-title";

/** The layout's grid and the sidebar part's view, which the layout keeps to itself (as `src/status/index.tsx` reads them). */
interface LayoutGrid {
  readonly workbenchGrid: Grid<IView>;
  readonly sideBarPartView: IView;
}

/** The bottom row as a view of the workbench's grid: a fixed height, any width, so the sidebar's column keeps its own. */
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

const run = (command: string) => () => void getService(ICommandService).then((commands) => commands.executeCommand(command));

function RowButton({ title, icon, command }: { title: string; icon: string; command: string }) {
  return (
    <button type="button" className="pult-panel-row-button" title={title} aria-label={title} onClick={run(command)}>
      <i className={`codicon codicon-${icon}`} aria-hidden />
    </button>
  );
}

/**
 * The left panel's header: room for the desktop's traffic lights
 * (`--pult-traffic-lights`, `src/desktop/titleBar.ts`), Collapse Panel,
 * Pult's logo and, rightmost, New Thread. In the desktop it drags the
 * window, its buttons excepted.
 */
function PanelHeader() {
  return (
    <>
      <span className="pult-panel-header-lights" />
      <RowButton title="Collapse Panel" icon="layout-sidebar-left" command="pult-shell.collapsePanel" />
      <img className="pult-panel-header-logo" src={logoUrl} alt="Pult" draggable={false} />
      <span className="pult-panel-row-spacer" />
      <RowButton title="New Thread" icon="add" command="pult-shell.newThread" />
    </>
  );
}

/** The left panel's bottom row: the tabs, and rightmost the gear, which opens the Pult settings page. */
function PanelFooter({ store }: { store: PanelTabStore }) {
  return (
    <>
      <PanelTabs store={store} />
      <span className="pult-panel-row-spacer" />
      <RowButton title="Settings" icon="settings-gear" command="pult-shell.selectSettings" />
    </>
  );
}

/**
 * The left panel's own parts around the sidebar part. The part keeps a 35px
 * title for every tab, which is the panel's top row: while the Pult tab is
 * open the header (`PanelHeader`) stands in it, in place of the tab's name
 * and buttons; any other tab's own title shows, leaving the traffic lights
 * their room (`panel.css`). Its right-click menu goes in Pult's mode, since
 * in the desktop the title drags the window. Below the part, the tabs with
 * the gear (`PanelFooter`, `PanelTabs.tsx`), a view added to the layout's
 * grid with the grid's own `addView` and shown with the part, so a
 * collapsed panel leaves no column behind. While the panel is collapsed,
 * Expand Panel sits at the window's top-left over the room the top-left
 * editor group's tabs row leaves it (`src/style.css`). Started once the
 * workbench is up.
 */
export async function startPanelRows(): Promise<void> {
  const [layout, panes] = await Promise.all([getService(IWorkbenchLayoutService), getService(IPaneCompositePartService)]);
  const { workbenchGrid, sideBarPartView } = layout as unknown as Partial<LayoutGrid>;
  const title = sideBarPartView?.element.querySelector<HTMLElement>(":scope > .composite.title");
  if (workbenchGrid === undefined || sideBarPartView === undefined || title === null || title === undefined) return;

  const header = document.createElement("div");
  header.className = "pult-panel-header";
  title.append(header);
  createRoot(header).render(<PanelHeader />);
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

  const footer = rowView("pult-panel-footer");
  workbenchGrid.addView(footer, ROW_HEIGHT, sideBarPartView, Direction.Down);
  createRoot(footer.element).render(<PanelFooter store={await panelTabStore()} />);

  const expand = document.createElement("div");
  expand.className = "pult-panel-expand";
  layout.mainContainer.append(expand);
  createRoot(expand).render(<RowButton title="Expand Panel" icon="layout-sidebar-left-off" command="pult-shell.expandPanel" />);

  const follow = () => {
    sideBarPartView.element.classList.toggle(HEADER_IN_TITLE, panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === PANEL_ID);
    workbenchGrid.setViewVisible(footer, layout.isVisible(Parts.SIDEBAR_PART));
  };
  layout.onDidChangePartVisibility((event) => {
    if (event.partId === Parts.SIDEBAR_PART) follow();
  });
  panes.onDidPaneCompositeOpen(follow);
  panes.onDidPaneCompositeClose(follow);
  follow();
}
