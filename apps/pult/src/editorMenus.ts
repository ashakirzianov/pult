import { MenuId, MenuRegistry, isIMenuItem, isISubmenuItem } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr, type ContextKeyExpression } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

import { VSCodeModeContext } from "./mode.ts";

/**
 * The stock entries of the editor's menus and the palette that Pult's mode
 * holds still (`startMode`, `src/mode.ts`; `pult/decisions`, `editor-tab-modes`):
 * the tab bar's modes, since a thread's tab is its header; the editor actions'
 * position, since the title bar they would move to never shows; and the
 * auxiliary windows, which the shell's one selection and editor part do not
 * span and the desktop wrapper does not open. Each a command, wherever it is
 * registered, or a submenu.
 */
const VSCODE_MODE_COMMANDS = new Set([
  "workbench.action.showMultipleEditorTabs",
  "workbench.action.showEditorTab",
  "workbench.action.hideEditorTabs",
  "workbench.action.configureEditorTabs",
  "workbench.action.editorActionsDefault",
  "workbench.action.editorActionsTitleBar",
  "workbench.action.hideEditorActions",
  "workbench.action.showEditorActions",
  "workbench.action.moveEditorToNewWindow",
  "workbench.action.copyEditorToNewWindow",
  "workbench.action.moveEditorGroupToNewWindow",
  "workbench.action.copyEditorGroupToNewWindow",
  "workbench.action.newEmptyEditorWindow",
]);
const VSCODE_MODE_SUBMENUS = new Set([MenuId.EditorTabsBarShowTabsSubmenu, MenuId.EditorActionsPositionSubmenu]);
const MENUS = [MenuId.EditorTabsBarContext, MenuId.EditorTitleContext, MenuId.CommandPalette];

/**
 * Shows those entries in VS Code mode alone: their registered items take
 * `pult.vscodeMode` into their `when`. Called before the workbench starts,
 * after the workbench's contributions have registered them; a command a
 * VS Code bump renames is reported, not fatal.
 */
export function gateEditorMenus(): void {
  const gated = new Set<string>();
  for (const menu of MENUS) {
    for (const item of MenuRegistry.getMenuItems(menu)) {
      const key = isIMenuItem(item) ? item.command.id : isISubmenuItem(item) ? item.submenu.id : undefined;
      const gate = isIMenuItem(item)
        ? VSCODE_MODE_COMMANDS.has(item.command.id)
        : isISubmenuItem(item) && VSCODE_MODE_SUBMENUS.has(item.submenu);
      if (!gate || key === undefined) continue;
      const amended: { when?: ContextKeyExpression } = item;
      amended.when = ContextKeyExpr.and(amended.when, VSCodeModeContext);
      gated.add(key);
    }
  }
  const missing = [...VSCODE_MODE_COMMANDS, ...[...VSCODE_MODE_SUBMENUS].map((submenu) => submenu.id)].filter((id) => !gated.has(id));
  if (missing.length > 0) console.warn("[pult-shell] menu entries not found to gate:", missing);
}
