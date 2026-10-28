import { getService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Action2, MenuId, MenuRegistry, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { registerCustomView, ViewContainerLocation } from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import markUrl from "../../assets/pult/mark.svg?no-inline";
import { allowNativeScroll } from "../nativeScroll.ts";
import { followExplorerScope, PANEL_ID, registerExplorerCommands, showThreads } from "./explorer.ts";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The tabs' order in the activity bar: Threads first, then the stock
 * explorer at its own 0. Projects (`pult/projects-tab`) goes after the
 * explorer, below Search's 1; Search and Extensions are unpinned by default
 * (`src/services.ts`).
 */
const THREADS_ORDER = -1;

/**
 * The left panel: the activity bar and the sidebar part, VS Code's own, the
 * bar switching the sidebar between view containers. The Threads tab is the
 * shell's own container, with one React view (the thread cards), Pult's
 * mark as its icon and New Thread in its title; the Explorer tab is VS Code's, rooted by `explorer.ts`.
 * Every other tab of the sidebar closes back to Threads, in Pult's mode. The
 * activity bar's gear opens the Pult settings page (`src/settings/gear.ts`). Collapsing is the sidebar's:
 * Cmd+B and the palette's Collapse Panel, and a chevron in the editor's
 * title brings it back while it is collapsed. Registered before the
 * workbench starts.
 */
export function registerPanel(): void {
  registerCustomView({
    id: PANEL_ID,
    name: "Threads",
    order: THREADS_ORDER,
    // The composite bar masks the icon with the tab's colour; it takes a URI, not a path.
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
  registerNewThreadAction();
  registerCloseTabAction();
  registerExplorerCommands();
  void followExplorerScope();
  registerSidebarToggle("pult-shell.collapsePanel", "Collapse Panel", true);
  registerSidebarToggle("pult-shell.expandPanel", "Expand Panel", false);
}

/**
 * New Thread, a plus in the Threads tab's title: `pult-shell.newThread`
 * (`src/threads/selection.ts`), which picks a project; the palette's entry is
 * the action's own.
 */
function registerNewThreadAction(): void {
  MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: { id: "pult-shell.newThread", title: { value: "New Thread", original: "New Thread" }, icon: Codicon.add },
    when: ContextKeyExpr.equals("view", PANEL_ID),
    group: "navigation",
    order: -1,
  });
}

/**
 * Close, an X last in the title of every sidebar tab but Threads, the main
 * one, which it shows instead; in Pult's mode only, as VS Code's tabs have
 * none. Not in the palette: Pult: Show Threads is.
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

/** Collapse is the palette's and Cmd+B's; Expand is also a chevron in the editor's title while the sidebar is collapsed. */
function registerSidebarToggle(id: string, title: string, hide: boolean): void {
  const sidebarVisible = ContextKeyExpr.equals("sideBarVisible", true);
  const where = hide
    ? []
    : [MenuId.EditorTitle, MenuId.EmptyEditorGroup].map((menu) => ({
        id: menu,
        when: ContextKeyExpr.not("sideBarVisible"),
        group: "navigation",
        order: -1000,
      }));
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id,
          title: { value: title, original: title },
          category: { value: "Pult", original: "Pult" },
          icon: hide ? Codicon.chevronLeft : Codicon.chevronRight,
          f1: true,
          precondition: hide ? sidebarVisible : ContextKeyExpr.not("sideBarVisible"),
          menu: where,
        });
      }

      async run(): Promise<void> {
        (await getService(IWorkbenchLayoutService)).setPartHidden(hide, Parts.SIDEBAR_PART);
      }
    },
  );
}
