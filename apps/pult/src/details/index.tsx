import {
  getService,
  ICommandService,
  IPaneCompositePartService,
  IStorageService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import { IsTopRightEditorGroupContext } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/contextkeys";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import {
  registerCustomView,
  ViewContainerLocation,
} from "@codingame/monaco-vscode-workbench-service-override/common";
import { createRoot } from "react-dom/client";

import { allowNativeScroll } from "../nativeScroll.ts";
import { allowNativeTextMenu } from "../nativeTextMenu.ts";
import { detailsColumn } from "./column.ts";
import { DetailsTitle, DetailsView } from "./DetailsView.tsx";
import "./details.css";

/** The Details view's container, the secondary side bar's one. */
const DETAILS_ID = "pult.details";
/** On the secondary side bar part while the title row stands in its title, the Details container's. */
const HEADER_IN_TITLE = "pult-header-in-title";

/** Hide Details, at the column's title row's right end, the window's top-right. */
function HideToggle() {
  return (
    <button
      type="button"
      className="pult-panel-row-button"
      title="Hide Details"
      aria-label="Hide Details"
      onClick={() =>
        void getService(ICommandService).then((commands) =>
          commands.executeCommand("pult-shell.hideDetails"),
        )
      }
    >
      <i className="codicon codicon-layout-sidebar-right" aria-hidden />
    </button>
  );
}

/**
 * The right panel (`pult/decisions`, `view-right-panel`): the workbench's
 * secondary side bar, as the left panel is its primary one, holding one
 * view, Details (`DetailsView.tsx`), with the palette's Pult: Show Details
 * and Hide Details, both on Cmd+Alt+B, VS Code's own key for the part, over
 * its stock toggle; Show Details is also the last of the top-right editor
 * group's tab bar actions while the column is closed, one of them. Registered
 * before the workbench starts.
 */
export function registerDetails(): void {
  registerCustomView({
    id: DETAILS_ID,
    name: "Details",
    location: ViewContainerLocation.AuxiliaryBar,
    default: true,
    canMoveView: false,
    renderBody(container) {
      container.style.height = "100%";
      allowNativeScroll(container);
      // Upstream's rows for a thread may hold a text field, which keeps the browser's menu.
      allowNativeTextMenu(container);
      const root = createRoot(container);
      root.render(<DetailsView />);
      return { dispose: () => root.unmount() };
    },
  });
  registerDetailsToggle("pult-shell.showDetails", "Show Details", false);
  registerDetailsToggle("pult-shell.hideDetails", "Hide Details", true);
}

function registerDetailsToggle(id: string, title: string, hide: boolean): void {
  const visible = ContextKeyExpr.equals("auxiliaryBarVisible", true);
  const precondition = hide ? visible : ContextKeyExpr.not("auxiliaryBarVisible");
  // After every other action, Split Editor's 100000 and a single tab's Close's 1000000 among them.
  const menu = hide
    ? undefined
    : {
        id: MenuId.EditorTitle,
        when: ContextKeyExpr.and(precondition, IsTopRightEditorGroupContext),
        group: "navigation",
        order: 1_000_001,
      };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id,
          title: { value: title, original: title },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.layoutSidebarRightOff,
          f1: true,
          precondition,
          menu,
          keybinding: {
            primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB,
            when: precondition,
            // Over the stock Toggle Secondary Side Bar Visibility's.
            weight: KeybindingWeight.WorkbenchContrib + 1,
          },
        });
      }

      async run(): Promise<void> {
        const [layout, panes] = await Promise.all([
          getService(IWorkbenchLayoutService),
          getService(IPaneCompositePartService),
        ]);
        layout.setPartHidden(hide, Parts.AUXILIARYBAR_PART);
        if (
          !hide &&
          panes.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId() !== DETAILS_ID
        )
          await panes.openPaneComposite(DETAILS_ID, ViewContainerLocation.AuxiliaryBar, false);
      }
    },
  );
}

/**
 * The column's own parts. The part keeps a 35px title, which is the
 * column's title row: while the Details container is open (in VS Code mode
 * another may be moved in) the row stands in it (`DetailsTitle`, then the
 * toggle at its right end), its right-click menu gone in Pult's mode, since
 * in the desktop the row drags the window. While the column is closed
 * Show Details is the top-right editor group's last tab bar action, that
 * group told by the workbench's own `isTopRightEditorGroup`. The open state is
 * the layout's, one for the whole app, saved at once on every change, as
 * the left panel's is (`src/panel/rows.tsx`); nothing but the toggle, its
 * commands and the key open it. Started once the workbench is up.
 */
export async function startDetailsRows(): Promise<void> {
  const [layout, panes, storage] = await Promise.all([
    getService(IWorkbenchLayoutService),
    getService(IPaneCompositePartService),
    getService(IStorageService),
  ]);
  const part = layout.getContainer(window, Parts.AUXILIARYBAR_PART);
  const title = part?.querySelector<HTMLElement>(":scope > .composite.title");
  if (part === undefined || title === null || title === undefined)
    throw new Error("The secondary side bar has no title to hold the Details column's row");

  const header = document.createElement("div");
  header.className = "pult-details-header";
  title.append(header);
  createRoot(header).render(
    <>
      <span className="pult-details-title">
        <DetailsTitle />
      </span>
      <HideToggle />
    </>,
  );
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

  const follow = () => {
    const details =
      panes.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.getId() === DETAILS_ID;
    part.classList.toggle(HEADER_IN_TITLE, details);
    detailsColumn.show(details && layout.isVisible(Parts.AUXILIARYBAR_PART));
  };
  layout.onDidChangePartVisibility((event) => {
    if (event.partId !== Parts.AUXILIARYBAR_PART) return;
    follow();
    // The layout stores the part's visibility only when the workbench saves its state: saved now, the next start keeps it.
    void storage.flush();
  });
  panes.onDidPaneCompositeOpen(follow);
  panes.onDidPaneCompositeClose(follow);
  follow();
}
