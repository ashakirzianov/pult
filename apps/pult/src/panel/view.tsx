import {
  getService,
  ILifecycleService,
  IPaneCompositePartService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import {
  LifecyclePhase,
  StartupKind,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/lifecycle/common/lifecycle";
import {
  registerCustomView,
  ViewContainerLocation,
} from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import markUrl from "../../assets/pult/mark.svg?no-inline";
import { allowNativeScroll } from "../nativeScroll.ts";
import {
  followExplorerScope,
  PANEL_ID,
  registerExplorerCommands,
  showThreads,
} from "./explorer.ts";
import { mountFilterCard } from "./filterCard.tsx";
import { registerJumps } from "./jump.ts";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The tabs' order in the panel's tray, in VS Code's mode: Pult first, then the stock
 * explorer at its own 0. Projects (`pult/projects-tab`) goes after the
 * explorer, below Search's 1; Search and Extensions are unpinned by default
 * (`src/services.ts`).
 */
const THREADS_ORDER = -1;

/**
 * The left panel: the sidebar part, VS Code's own, between two rows of the
 * shell's (`rows.tsx`): the Pult tab's header, in that tab's title (the
 * desktop's traffic lights, Collapse Panel, Pult's logo and New Thread),
 * every other tab's own title the panel's top row; and below, the tray, the
 * tabs switching the sidebar between view containers in place of VS Code's
 * activity bar (`PanelTabs.tsx`), the closed shelves' icons
 * (`TrayShelves.tsx`), and the gear, which opens the Pult settings page. The Pult tab is the shell's own
 * container, with one React view (the Explorer card and the thread cards)
 * and Pult's mark as its icon; the Explorer tab is VS Code's, rooted by
 * `explorer.ts`, its filter a card above the tree (`filterCard.tsx`). Every
 * other tab of the sidebar closes back to the Pult tab, which in Pult's
 * mode has no button of its own. Collapsing is the sidebar's: the header's
 * toggle, Cmd+B and the palette's Collapse Panel; while it is collapsed,
 * Expand Panel sits at the window's top-left (`rows.tsx`). Cmd+1 to Cmd+9
 * jump to the panel's rows (`jump.ts`). Registered before the workbench
 * starts.
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
  void showPultTabOnStart();
  registerCloseTabAction();
  registerExplorerCommands();
  registerJumps();
  void followExplorerScope();
  void mountFilterCard();
  registerSidebarToggle("pult-shell.collapsePanel", "Collapse Panel", true);
  registerSidebarToggle("pult-shell.expandPanel", "Expand Panel", false);
}

/**
 * The Pult tab on a start that is no reload: the workbench opens the
 * registry's default sidebar tab then, which is the Explorer, registered
 * before Pult's container can be (a reload restores the tab it left, the
 * Explorer's falling back to Pult's, `src/services.ts`). Leaves a collapsed
 * sidebar collapsed, and the focus where it is.
 */
async function showPultTabOnStart(): Promise<void> {
  const lifecycle = await getService(ILifecycleService);
  if (lifecycle.startupKind === StartupKind.ReloadedWindow) return;
  await lifecycle.when(LifecyclePhase.Restored);
  const layout = await getService(IWorkbenchLayoutService);
  const panes = await getService(IPaneCompositePartService);
  if (
    !layout.isVisible(Parts.SIDEBAR_PART) ||
    panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId() === PANEL_ID
  )
    return;
  await panes.openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar, false);
}

/**
 * Close, an X last in the title of every sidebar tab but Pult, the main
 * one, which it shows instead, and Escape while the sidebar has focus, but
 * not while an input does or a tree's find box is open, which take it
 * first; a list's selection does not, or Escape would never get past it.
 * In Pult's mode only, as VS Code's tabs have none. Not in the palette:
 * Pult: Show Pult Tab is.
 */
function registerCloseTabAction(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.closeSidebarTab",
          title: { value: "Close", original: "Close" },
          icon: Codicon.close,
          keybinding: {
            primary: KeyCode.Escape,
            when: ContextKeyExpr.and(
              ContextKeyExpr.equals("sideBarFocus", true),
              ContextKeyExpr.notEquals("activeViewlet", PANEL_ID),
              ContextKeyExpr.not("inputFocus"),
              ContextKeyExpr.not("treeFindOpen"),
              ContextKeyExpr.not("pult.vscodeMode"),
            ),
            // Over the lists' own Escape, which clears their selection.
            weight: KeybindingWeight.WorkbenchContrib + 1,
          },
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
