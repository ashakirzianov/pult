import { getService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Action2, MenuId, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { registerCustomView, ViewContainerLocation } from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import { followSidebar, PANEL_ID, registerExplorerCommands } from "./explorer.ts";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The left panel: the sidebar part, holding the shell's own view container
 * with one React view (logo, thread cards, footer), and VS Code's explorer
 * container swapped in by `explorer.ts`. Collapsing is the sidebar's: Cmd+B,
 * the chevron in the panel's title, and a chevron in the editor's title while
 * it is collapsed. Registered before the workbench starts.
 */
export function registerPanel(): void {
  registerCustomView({
    id: PANEL_ID,
    name: "Threads",
    location: ViewContainerLocation.Sidebar,
    default: true,
    canMoveView: false,
    renderBody(container) {
      container.style.height = "100%";
      const root = createRoot(container);
      root.render(<PanelView />);
      return { dispose: () => root.unmount() };
    },
  });
  registerExplorerCommands();
  void followSidebar();
  registerSidebarToggle("pult-shell.collapsePanel", "Collapse Panel", true);
  registerSidebarToggle("pult-shell.expandPanel", "Expand Panel", false);
}

function registerSidebarToggle(id: string, title: string, hide: boolean): void {
  const sidebarVisible = ContextKeyExpr.equals("sideBarVisible", true);
  const where = hide
    ? [PANEL_ID, "workbench.explorer.fileView"].map((view) => ({
        id: MenuId.ViewTitle,
        when: ContextKeyExpr.equals("view", view),
        group: "navigation",
        order: 1000,
      }))
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
