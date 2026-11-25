import {
  type IMenuItem,
  type ISubmenuItem,
  MenuId,
  MenuRegistry,
  isIMenuItem,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  ContextKeyExpr,
  type ContextKeyExpression,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

import { VSCodeModeContext } from "./mode.ts";

/**
 * The stock entries of the editor's menus and the palette that Pult's mode
 * holds still (`startMode`, `src/mode.ts`; `pult/decisions`, `editor-tab-modes`):
 * the tab bar's modes, since a thread's tab is its header; the editor actions'
 * position, since the title bar they would move to never shows; and the
 * auxiliary windows, which the shell's one selection and editor part do not
 * span (`AUXILIARY_WINDOW_COMMANDS`). Each a command, wherever it is
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
]);
/**
 * The auxiliary windows' commands, shown in VS Code mode in a browser tab
 * alone: the desktop app's windows deny the `about:blank` popup the workbench
 * opens them through, so there they are hidden in both modes
 * (`pult/tasks/open-in-new-window.task` decides whether they open).
 */
const AUXILIARY_WINDOW_COMMANDS = new Set([
  "workbench.action.moveEditorToNewWindow",
  "workbench.action.copyEditorToNewWindow",
  "workbench.action.moveEditorGroupToNewWindow",
  "workbench.action.copyEditorGroupToNewWindow",
  "workbench.action.newEmptyEditorWindow",
]);
/**
 * New Window, kept in a browser tab, where it opens a second tab of the page,
 * and hidden in the desktop app in both modes: it opens the page's `pult:`
 * URL (`workspaceProvider.open`, `src/main.ts`), which the desktop app's
 * windows deny.
 */
const NEW_WINDOW_COMMAND = "workbench.action.newWindow";
const VSCODE_MODE_SUBMENUS = new Set([
  MenuId.EditorTabsBarShowTabsSubmenu,
  MenuId.EditorActionsPositionSubmenu,
]);
const MENUS = [MenuId.EditorTabsBarContext, MenuId.EditorTitleContext, MenuId.CommandPalette];

/**
 * The stock buttons of a tab bar's actions that Pult's mode leaves out, each
 * a command, kept in the palette and Open With: the Markdown extension's
 * Open Preview to the Side and Open as Preview, the reader's Show Preview
 * being a Markdown file's one preview button (`src/reader/`). They are
 * registered once the extension's contributions are read, after the
 * workbench starts.
 */
const VSCODE_MODE_TITLE_COMMANDS = new Set([
  "markdown.showPreviewToSide",
  "markdown.reopenAsPreview",
]);

const amended = new WeakSet<object>();

/** Has the registered items of `menu` that `gate` names take `condition(key)`, `pult.vscodeMode` by default, into their `when`, once each; answers the keys of those it names. */
function gateItems(
  menu: MenuId,
  gate: (item: IMenuItem | ISubmenuItem) => string | undefined,
  condition: (key: string) => ContextKeyExpression = () => VSCodeModeContext,
) {
  const keys = new Set<string>();
  for (const item of MenuRegistry.getMenuItems(menu)) {
    const key = gate(item);
    if (key === undefined) continue;
    keys.add(key);
    if (amended.has(item)) continue;
    const gated: { when?: ContextKeyExpression } = item;
    gated.when = ContextKeyExpr.and(gated.when, condition(key));
    amended.add(item);
  }
  return keys;
}

const gateEditorMenu = (desktop: boolean) => (item: IMenuItem | ISubmenuItem) =>
  isIMenuItem(item)
    ? VSCODE_MODE_COMMANDS.has(item.command.id) ||
      AUXILIARY_WINDOW_COMMANDS.has(item.command.id) ||
      (desktop && item.command.id === NEW_WINDOW_COMMAND)
      ? item.command.id
      : undefined
    : VSCODE_MODE_SUBMENUS.has(item.submenu)
      ? item.submenu.id
      : undefined;

const gateTitle = (item: IMenuItem | ISubmenuItem) =>
  isIMenuItem(item) && VSCODE_MODE_TITLE_COMMANDS.has(item.command.id)
    ? item.command.id
    : undefined;

/**
 * Shows those entries in VS Code mode alone: their registered items take
 * `pult.vscodeMode` into their `when`, and in the desktop app (`desktop`,
 * `window.pultDesktop` present) the auxiliary windows' a false one, hidden
 * in both modes, an empty group's New Window too, and the workbench's New
 * Window. Called before the workbench starts,
 * after the workbench's contributions have registered them, and the tab
 * bar's buttons as items are added to it; a command a VS Code bump renames
 * is reported, not fatal (a Markdown button's shows again instead).
 */
export function gateEditorMenus(desktop: boolean): void {
  const condition = (key: string) =>
    desktop && (AUXILIARY_WINDOW_COMMANDS.has(key) || key === NEW_WINDOW_COMMAND)
      ? ContextKeyExpr.false()
      : VSCodeModeContext;
  const gated = new Set(
    MENUS.flatMap((menu) => [...gateItems(menu, gateEditorMenu(desktop), condition)]),
  );
  // An empty group's menu offers New Empty Editor Window as New Window, in either mode.
  if (desktop)
    gateItems(
      MenuId.EmptyEditorGroupContext,
      (item) =>
        isIMenuItem(item) && AUXILIARY_WINDOW_COMMANDS.has(item.command.id)
          ? item.command.id
          : undefined,
      () => ContextKeyExpr.false(),
    );
  gateItems(MenuId.EditorTitle, gateTitle);
  // Ahead of a menu's rebuild, which waits for the changes' debounce.
  MenuRegistry.onDidChangeMenu((event) => {
    if (event.has(MenuId.EditorTitle)) gateItems(MenuId.EditorTitle, gateTitle);
  });
  const missing = [
    ...VSCODE_MODE_COMMANDS,
    ...AUXILIARY_WINDOW_COMMANDS,
    ...(desktop ? [NEW_WINDOW_COMMAND] : []),
    ...[...VSCODE_MODE_SUBMENUS].map((submenu) => submenu.id),
  ].filter((id) => !gated.has(id));
  if (missing.length > 0) console.warn("[pult-shell] menu entries not found to gate:", missing);
}
