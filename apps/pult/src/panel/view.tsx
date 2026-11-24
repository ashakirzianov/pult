import {
  getService,
  ILifecycleService,
  IPaneCompositePartService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import type { IToolBarResponsiveBehaviorOptions } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/toolbar/toolbar";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import {
  Action2,
  isIMenuItem,
  MenuId,
  MenuRegistry,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import { SidebarPart } from "@codingame/monaco-vscode-api/vscode/vs/workbench/browser/parts/sidebar/sidebarPart";
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
import { modeChoice, VSCODE_MODE_CLASS, VSCodeModeContext } from "../mode.ts";
import { allowNativeScroll } from "../nativeScroll.ts";
import {
  followExplorerScope,
  PANEL_ID,
  registerExplorerCommands,
  registerExplorerHeaderActions,
  showThreads,
} from "./explorer.ts";
import { mountFilterCard } from "./filterCard.tsx";
import { registerJumps } from "./jump.ts";
import { UNDESIGNED_TABS } from "./PanelTabs.tsx";
import { PanelView } from "./PanelView.tsx";
import "./panel.css";

/**
 * The tabs' order in the panel's tray, in VS Code's mode: Pult first, then the stock
 * explorer at its own 0. Projects (`pult/projects-tab`) goes after the
 * explorer, below Search's 1.
 */
const THREADS_ORDER = -1;

/**
 * Pult's sidebar container, with one React view. In Pult mode the shared header
 * switches containers and shows the active container's toolbar (`rows.tsx`).
 * Escape from another sidebar tab returns to Pult. Cmd+1 to Cmd+9 jump to rows
 * in Pult's view (`jump.ts`). Registered before the workbench starts.
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
  responsiveSidebarToolbar();
  registerNewMenu();
  hideUndesignedTabs();
  registerCloseTabAction();
  registerExplorerCommands();
  registerExplorerHeaderActions();
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
 * The sidebar title's toolbar, the active tab's actions, puts what does not
 * fit under its own "..." in Pult mode, after the header's tabs have taken
 * their room (`rows.tsx`): the workbench's responsive toolbar, as the
 * secondary side bar's part configures it. The part reads this once, as it
 * creates its title, so it is set before the workbench starts.
 */
function responsiveSidebarToolbar(): void {
  const part = SidebarPart.prototype as unknown as {
    getToolbarResponsiveBehavior?: () => IToolBarResponsiveBehaviorOptions | undefined;
  };
  if (part.getToolbarResponsiveBehavior === undefined)
    throw new Error("Pult: the sidebar part has no toolbar behaviour to configure.");
  part.getToolbarResponsiveBehavior = () => ({
    enabled: true,
    kind: "all",
    minItems: 0,
    actionMinWidth: 22,
    allowOverflow: () =>
      document.querySelector(".monaco-workbench")?.classList.contains(VSCODE_MODE_CLASS) !== true,
  });
}

/** The Pult tab's New, a menu of New Thread and New Star (while Create Star is offered), first in its toolbar. */
function registerNewMenu(): void {
  const menu = new MenuId("pult.panel.new");
  MenuRegistry.appendMenuItem(MenuId.ViewContainerTitle, {
    submenu: menu,
    title: "New",
    icon: Codicon.add,
    group: "navigation",
    order: -1,
    when: ContextKeyExpr.equals("viewContainer", PANEL_ID),
  });
  MenuRegistry.appendMenuItems([
    { id: menu, item: { command: { id: "pult-shell.newThread", title: "New Thread" }, order: 1 } },
    {
      id: menu,
      item: {
        command: {
          id: "pult-shell.createStar",
          title: "New Star",
          precondition: ContextKeyExpr.has("pult.canCreateStar"),
        },
        order: 2,
      },
    },
  ]);
}

/**
 * Pult mode's undesigned tabs (`UNDESIGNED_TABS`): their palette commands
 * shown in VS Code mode alone, and the tab, opened any other way, giving way
 * to the Pult tab, as it does when the mode turns to Pult with one open.
 */
function hideUndesignedTabs(): void {
  const hidden = new Set<string>();
  const tabsFound = new Set<string>();
  // The views' own commands register once the workbench has started, so again as the palette's items change.
  const hidePalette = () => {
    for (const item of MenuRegistry.getMenuItems(MenuId.CommandPalette)) {
      if (!isIMenuItem(item) || hidden.has(item.command.id)) continue;
      const tab = [...UNDESIGNED_TABS].find(([, opens]) => opens(item.command.id))?.[0];
      if (tab === undefined) continue;
      item.when = ContextKeyExpr.and(item.when, VSCodeModeContext);
      hidden.add(item.command.id);
      tabsFound.add(tab);
    }
  };
  hidePalette();
  MenuRegistry.onDidChangeMenu((event) => {
    if (event.has(MenuId.CommandPalette)) hidePalette();
  });
  void getService(ILifecycleService)
    .then((lifecycle) => lifecycle.when(LifecyclePhase.Eventually))
    .then(() => {
      const missing = [...UNDESIGNED_TABS.keys()].filter((tab) => !tabsFound.has(tab));
      if (missing.length > 0)
        console.warn("[pult-shell] no palette commands found to hide for:", missing);
    });
  void (async () => {
    const [panes, mode] = await Promise.all([getService(IPaneCompositePartService), modeChoice()]);
    const leave = () => {
      const open = panes.getActivePaneComposite(ViewContainerLocation.Sidebar)?.getId();
      if (mode.current() === "pult" && open !== undefined && UNDESIGNED_TABS.has(open))
        void panes.openPaneComposite(PANEL_ID, ViewContainerLocation.Sidebar, true);
    };
    panes.onDidPaneCompositeOpen(leave);
    mode.onDidChange(leave);
    leave();
  })();
}

/** Escape goes back to Pult from a focused sidebar, after inputs and tree find have handled it. */
function registerCloseTabAction(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.closeSidebarTab",
          title: { value: "Close", original: "Close" },
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
        });
      }

      run(): Promise<void> {
        return showThreads();
      }
    },
  );
}

/** The palette's Collapse Panel and Expand Panel, which the panel and the window's top-left show as buttons (`rows.tsx`). */
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
