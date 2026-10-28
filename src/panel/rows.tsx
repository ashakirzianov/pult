import { getService, ICommandService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Direction, type Grid, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/grid/grid";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { createRoot } from "react-dom/client";

import logoUrl from "../../assets/pult/logo-color.svg";
import { panelTabStore, PanelTabs } from "./PanelTabs.tsx";

/** Both rows' height: the sidebar's title and the editor's tabs row are 35px, so the header and the tabs row are one band. */
const ROW_HEIGHT = 35;

/** The layout's grid and the sidebar part's view, which the layout keeps to itself (as `src/status/index.tsx` reads them). */
interface LayoutGrid {
  readonly workbenchGrid: Grid<IView>;
  readonly sideBarPartView: IView;
}

/** A row as a view of the workbench's grid: a fixed height, any width, so the sidebar's column keeps its own. */
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

/**
 * The left panel's header: room for the desktop's traffic lights
 * (`--pult-traffic-lights`, `src/desktop/titleBar.ts`), Collapse Panel,
 * Pult's logo and, rightmost, the gear, which opens the Pult settings page.
 * In the desktop it drags the window, its buttons excepted.
 */
function PanelHeader() {
  return (
    <>
      <span className="pult-panel-header-lights" />
      <button type="button" className="pult-panel-header-button" title="Collapse Panel" aria-label="Collapse Panel" onClick={run("pult-shell.collapsePanel")}>
        <i className="codicon codicon-layout-sidebar-left" aria-hidden />
      </button>
      <img className="pult-panel-header-logo" src={logoUrl} alt="Pult" draggable={false} />
      <span className="pult-panel-header-spacer" />
      <button type="button" className="pult-panel-header-button" title="Settings" aria-label="Settings" onClick={run("pult-shell.selectSettings")}>
        <i className="codicon codicon-settings-gear" aria-hidden />
      </button>
    </>
  );
}

/**
 * The left panel's two rows of the shell's own, views added to the
 * layout's grid above and below the sidebar part with the grid's own
 * `addView`: the header (`PanelHeader`) and the tabs (`PanelTabs.tsx`).
 * They show and hide with the sidebar, so a collapsed panel leaves no
 * column behind. Started once the workbench is up.
 */
export async function startPanelRows(): Promise<void> {
  const layout = await getService(IWorkbenchLayoutService);
  const { workbenchGrid, sideBarPartView } = layout as unknown as Partial<LayoutGrid>;
  if (workbenchGrid === undefined || sideBarPartView === undefined) return;

  const header = rowView("pult-panel-header");
  const tabs = rowView("pult-panel-tabs-row");
  workbenchGrid.addView(header, ROW_HEIGHT, sideBarPartView, Direction.Up);
  workbenchGrid.addView(tabs, ROW_HEIGHT, sideBarPartView, Direction.Down);
  createRoot(header.element).render(<PanelHeader />);
  createRoot(tabs.element).render(<PanelTabs store={await panelTabStore()} />);

  const follow = () => {
    const visible = layout.isVisible(Parts.SIDEBAR_PART);
    workbenchGrid.setViewVisible(header, visible);
    workbenchGrid.setViewVisible(tabs, visible);
  };
  layout.onDidChangePartVisibility((event) => {
    if (event.partId === Parts.SIDEBAR_PART) follow();
  });
  follow();
}
