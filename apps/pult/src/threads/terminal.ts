// The thread's terminal is upstream's drawer under its composer, which the
// view's Cmd+J toggles; Toggle Terminal is the shell's way to it: Ctrl+`, the
// palette and a button beside Split Editor in every group's tab bar.
import {
  getService,
  IEditorGroupsService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";

import { isLeadTab, threadView } from "./pane.tsx";
import { ThreadSelectedContext } from "./park.ts";
import { selectionTarget } from "./selection.ts";

/**
 * Toggles the selection's thread's drawer. With the thread's tab hidden under
 * another in its group, it shows that tab and opens the drawer rather than
 * closing it unseen.
 */
async function toggleTerminal(groups: IEditorGroupsService): Promise<void> {
  const target = selectionTarget();
  if (target === undefined || !("threadId" in target)) return;
  const group = groups.groups.find((candidate) => candidate.editors.some(isLeadTab));
  const lead = group?.editors.find(isLeadTab);
  const hidden = group !== undefined && lead !== undefined && group.activeEditor !== lead;
  if (hidden) await group.openEditor(lead);
  const view = await threadView();
  view.toggleTerminal(target.environmentId, target.threadId, hidden);
}

/**
 * Registers Pult: Toggle Terminal (`pult-shell.toggleTerminal`) on the
 * selection's thread. The terminal takes every key it is given, so Ctrl+` in
 * it never reaches the workbench's keybinding; the page's capture listener
 * runs it there, as the view's own listener runs Cmd+J.
 */
export function registerTerminalCommand(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.code !== "Backquote" || !event.ctrlKey) return;
      if (event.metaKey || event.altKey || event.shiftKey) return;
      if (!document.activeElement?.closest("[data-terminal-owner=drawer]")) return;
      event.preventDefault();
      event.stopPropagation();
      void getService(IEditorGroupsService).then(toggleTerminal);
    },
    true,
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.toggleTerminal",
          title: { value: "Toggle Terminal", original: "Toggle Terminal" },
          category: { value: "Pult", original: "Pult" },
          icon: Codicon.terminal,
          f1: true,
          precondition: ThreadSelectedContext,
          keybinding: {
            primary: KeyMod.WinCtrl | KeyCode.Backquote,
            weight: KeybindingWeight.WorkbenchContrib + 1,
          },
          // Right beside Split Editor (its order is 100000), after Open Browser.
          menu: {
            id: MenuId.EditorTitle,
            when: ThreadSelectedContext,
            group: "navigation",
            order: 99_999.5,
          },
        });
      }

      run(accessor: ServicesAccessor): Promise<void> {
        return toggleTerminal(accessor.get(IEditorGroupsService));
      }
    },
  );
}
