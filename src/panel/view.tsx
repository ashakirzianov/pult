import { getService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { registerCustomView, ViewContainerLocation } from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import markUrl from "../../assets/pult/mark.svg?no-inline";
import { allowNativeScroll } from "../nativeScroll.ts";
import { followExplorerScope, PANEL_ID, registerExplorerCommands, showThreads } from "./explorer.ts";
import { mountFilterCard } from "./filterCard.tsx";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The tabs' order in the panel's bottom row: Pult first, then the stock
 * explorer at its own 0. Projects (`pult/projects-tab`) goes after the
 * explorer, below Search's 1; Search and Extensions are unpinned by default
 * (`src/services.ts`).
 */
const THREADS_ORDER = -1;

/**
 * The left panel: the sidebar part, VS Code's own, between two rows of the
 * shell's (`rows.tsx`): the Pult tab's header, in that tab's title (the
 * desktop's traffic lights, Collapse Panel, Pult's logo and New Thread),
 * every other tab's own title the panel's top row; and below, the tabs,
 * switching the sidebar between view containers in place of VS Code's
 * activity bar (`PanelTabs.tsx`), and the gear, which opens the Pult
 * settings page. The Pult tab is the shell's own
 * container, with one React view (the Explorer card and the thread cards)
 * and Pult's mark as its icon; the Explorer tab is VS Code's, rooted by
 * `explorer.ts`, its filter a card above the tree (`filterCard.tsx`). Every
 * other tab of the sidebar closes back to the Pult tab, which in Pult's
 * mode has no button of its own. Collapsing is the sidebar's: the header's
 * toggle, Cmd+B and the palette's Collapse Panel; while it is collapsed,
 * Expand Panel sits at the window's top-left (`rows.tsx`). Registered
 * before the workbench starts.
 */
export function registerPanel(): void {
  registerCustomView({
    id: PANEL_ID,
    name: "Pult",
    order: THREADS_ORDER,
    // The panel's tabs (`PanelTabs.tsx`) mask the icon with the tab's colour; it takes a URI, not a path.
    icon: new URL(markUrl, window.location.href).href,
    location: ViewContainerLocation.Sidebar,
    default: true,
    canMoveView: false,
    renderBody(container) {
      container.style.height = "100%";
      // The cards' list is a native scroller.
      allowNativeScroll(container);
      const root = createRoot(container);
      root.render(<PanelView />);
      return { dispose: () => root.unmount() };
    },
  });
  registerCloseTabAction();
  registerExplorerCommands();
  void followExplorerScope();
  void mountFilterCard();
  registerSidebarToggle("pult-shell.collapsePanel", "Collapse Panel", true);
  registerSidebarToggle("pult-shell.expandPanel", "Expand Panel", false);
}

/**
 * Close, an X last in the title of every sidebar tab but Threads, the main
 * one, which it shows instead; in Pult's mode only, as VS Code's tabs have
 * none. Not in the palette: Pult: Show Pult Tab is.
 */
function registerCloseTabAction(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.closeSidebarTab",
          title: { value: "Close", original: "Close" },
          icon: Codicon.close,
          menu: {
            id: MenuId.ViewContainerTitle,
            when: ContextKeyExpr.and(
              ContextKeyExpr.equals("viewContainerLocation", "sidebar"),
              ContextKeyExpr.notEquals("viewContainer", PANEL_ID),
              ContextKeyExpr.not("pult.vscodeMode"),
            ),
            group: "navigation",
            order: 1000,
          },
        });
      }

      run(): Promise<void> {
        return showThreads();
      }
    },
  );
}

/** The palette's Collapse Panel and Expand Panel, which the panel's header and the window's top-left show as buttons (`rows.tsx`). */
function registerSidebarToggle(id: string, title: string, hide: boolean): void {
  const sidebarVisible = ContextKeyExpr.equals("sideBarVisible", true);
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id,
          title: { value: title, original: title },
          category: { value: "Pult", original: "Pult" },
          f1: true,
          precondition: hide ? sidebarVisible : ContextKeyExpr.not("sideBarVisible"),
        });
      }

      async run(): Promise<void> {
        (await getService(IWorkbenchLayoutService)).setPartHidden(hide, Parts.SIDEBAR_PART);
      }
    },
  );
}
