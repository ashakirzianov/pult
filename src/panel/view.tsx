import { getService, IContextKeyService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { Action2, MenuId, MenuRegistry, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { registerCustomView, ViewContainerLocation } from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import markUrl from "../../assets/pult/mark.svg?no-inline";
import { isSettingsSelected, onDidSelectThread } from "../threads/selection.ts";
import { followExplorerScope, PANEL_ID, registerExplorerCommands } from "./explorer.ts";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The tabs' order in the sidebar's composite bar: Threads first, then the
 * stock explorer at its own 0. Projects (`pult/projects-tab`) goes after
 * the explorer, below Search's 1; Search and Extensions are unpinned by
 * default (`src/services.ts`).
 */
const THREADS_ORDER = -1;

/** Whether Settings is the selection: the gear in the sidebar's title shows it pressed. */
const SettingsSelectedContext = new RawContextKey<boolean>("pult.settingsSelected", false);

/**
 * The left panel: the sidebar part, switching between view containers
 * through VS Code's own composite bar (`workbench.activityBar.location` in
 * `src/configuration.json`). The Threads tab is the shell's own container,
 * with one React view (the thread cards), and Pult's mark as its icon; the
 * Explorer tab is VS Code's, rooted by `explorer.ts`. The sidebar's title
 * holds Settings and the collapse chevron on every tab. Collapsing is the
 * sidebar's: Cmd+B, that chevron, and a chevron in the editor's title while
 * it is collapsed. Registered before the workbench starts.
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
      const root = createRoot(container);
      root.render(<PanelView />);
      return { dispose: () => root.unmount() };
    },
  });
  registerExplorerCommands();
  void followExplorerScope();
  MenuRegistry.appendMenuItem(MenuId.SidebarTitle, {
    command: {
      id: "pult-shell.selectSettings",
      title: { value: "Settings", original: "Settings" },
      icon: Codicon.settingsGear,
      toggled: SettingsSelectedContext,
    },
    group: "navigation",
    order: 900,
  });
  void followSettingsSelection();
  registerSidebarToggle("pult-shell.collapsePanel", "Collapse Panel", true);
  registerSidebarToggle("pult-shell.expandPanel", "Expand Panel", false);
}

async function followSettingsSelection(): Promise<void> {
  const key = SettingsSelectedContext.bindTo(await getService(IContextKeyService));
  key.set(isSettingsSelected());
  onDidSelectThread(() => key.set(isSettingsSelected()));
}

function registerSidebarToggle(id: string, title: string, hide: boolean): void {
  const sidebarVisible = ContextKeyExpr.equals("sideBarVisible", true);
  const where = hide
    ? [{ id: MenuId.SidebarTitle, group: "navigation", order: 1000 }]
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
