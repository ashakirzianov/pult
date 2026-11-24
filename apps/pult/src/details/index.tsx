import {
  getService,
  IContextKeyService,
  IEditorGroupsService,
  IEditorService,
  IWorkbenchLayoutService,
} from "@codingame/monaco-vscode-api";
import { Codicon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/codicons";
import { KeyCode, KeyMod } from "@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes";
import {
  Action2,
  MenuId,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  ContextKeyExpr,
  type IContextKey,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { KeybindingWeight } from "@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry";
import {
  EditorResourceAccessor,
  SideBySideEditor,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import { IsTopRightEditorGroupContext } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/contextkeys";
import { Parts } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService";
import { createRoot } from "react-dom/client";

import { selectedTarget } from "../composer/index.tsx";
import { PULT_SCHEME } from "../files/paths.ts";
import { starById, starStore, starTarget } from "../stars/model.ts";
import { DraftInput, StarInput, StarThreadInput, ThreadInput } from "../threads/pane.tsx";
import { onDidSelectThread } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import type { DetailsCards, DetailsCardsTarget } from "../../view/main.tsx";
import { detailsCards } from "./cards.ts";
import { DetailsTray } from "./DetailsTray.tsx";
import { detailsSubject, StarCards } from "./DetailsView.tsx";
import { fileDetailsPanel } from "./filePanel.tsx";
import "./details.css";

/** Whether the cards are open: one state for the whole app, kept for the page's next start. */
const OPEN_KEY = "pult-shell.details.open";
const OPEN_CONTEXT = "pult.detailsOpen";
/** While the active editor can show the selection's details. */
const DETAILS_AVAILABLE_CONTEXT = "pult.detailsAvailable";

let open = localStorage.getItem(OPEN_KEY) === "true";
let openKey: IContextKey<boolean> | undefined;
let update: () => void = () => {};

function setOpen(next: boolean): void {
  open = next;
  localStorage.setItem(OPEN_KEY, String(next));
  openKey?.set(next);
  update();
}

/**
 * The right panel's commands (`pult/decisions`, `view-right-panel`): the
 * palette's Pult: Show Details and Hide Details, both on Cmd+Alt+B, VS
 * Code's own key for its secondary side bar, over its stock toggle, and
 * whichever is offered the last of the top-right editor group's tab bar
 * actions while a thread or one of its files is active. Registered before
 * the workbench starts.
 */
export function registerDetails(): void {
  registerDetailsToggle("pult-shell.showDetails", "Show Details", true);
  registerDetailsToggle("pult-shell.hideDetails", "Hide Details", false);
}

function registerDetailsToggle(id: string, title: string, show: boolean): void {
  const precondition = show
    ? ContextKeyExpr.not(OPEN_CONTEXT)
    : ContextKeyExpr.equals(OPEN_CONTEXT, true);
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id,
          title: { value: title, original: title },
          category: { value: "Pult", original: "Pult" },
          icon: show ? Codicon.layoutSidebarRightOff : Codicon.layoutSidebarRight,
          f1: true,
          precondition,
          // After every other action, Split Editor's 100000 and a single tab's Close's 1000000 among them.
          menu: {
            id: MenuId.EditorTitle,
            when: ContextKeyExpr.and(
              precondition,
              ContextKeyExpr.equals(DETAILS_AVAILABLE_CONTEXT, true),
              IsTopRightEditorGroupContext,
            ),
            group: "navigation",
            order: 1_000_001,
          },
          keybinding: {
            primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB,
            when: precondition,
            // Over the stock Toggle Secondary Side Bar Visibility's.
            weight: KeybindingWeight.WorkbenchContrib + 1,
          },
        });
      }

      run(): void {
        setOpen(show);
      }
    },
  );
}

/** The thread view an editor is: a thread's, a draft's, a Star's (its conversation, or asleep its draft), a Star's channel's or child's; null for any other. */
function threadViewOf(editor: unknown): DetailsCardsTarget | null {
  if (editor instanceof StarThreadInput && editor.starId !== undefined)
    return editor.channelTarget() ?? null;
  if (editor instanceof ThreadInput || editor instanceof StarThreadInput)
    return { kind: "thread", environmentId: editor.environmentId, threadId: editor.threadId };
  if (editor instanceof DraftInput)
    return { kind: "draft", environmentId: editor.environmentId, projectId: editor.projectId };
  if (editor instanceof StarInput) {
    const star = starById(editor.starId);
    return (star === undefined ? undefined : starTarget(star)) ?? null;
  }
  return null;
}

/** What the cards show while open over a thread's view: the selection's details, a thread's, a draft's or a Star's. */
function cardsOver(over: DetailsCardsTarget, editor: unknown): DetailsCards | null {
  const subject = detailsSubject();
  switch (subject.kind) {
    case "star":
      return {
        view: over,
        subject: {
          kind: "star",
          channel:
            editor instanceof StarInput
              ? "user"
              : editor instanceof StarThreadInput
                ? editor.slug
                : null,
        },
      };
    case "thread":
      return {
        view: over,
        subject: {
          kind: "thread",
          environmentId: subject.thread.environmentId,
          threadId: subject.thread.id,
        },
      };
    case "draft":
      return {
        view: over,
        subject: {
          kind: "draft",
          environmentId: subject.environmentId,
          projectId: subject.projectId,
        },
      };
    // A thread's view under the Explorer workspace, or before the selection is in: nothing to show.
    case "explorer":
    case "none":
      return null;
  }
}

/** Follow the active editor and the selection. Thread tabs host the cards on their canvas, files beside their editor. */
export async function startDetails(): Promise<void> {
  const [layout, editors, groups, contextKeys] = await Promise.all([
    getService(IWorkbenchLayoutService),
    getService(IEditorService),
    getService(IEditorGroupsService),
    getService(IContextKeyService),
  ]);
  openKey = contextKeys.createKey(OPEN_CONTEXT, open);
  const availableKey = contextKeys.createKey<boolean>(DETAILS_AVAILABLE_CONTEXT, false);
  // The docked column of 0.0.25 left the part open in a profile; nothing lives there now.
  layout.setPartHidden(true, Parts.AUXILIARYBAR_PART);

  detailsCards.setStarRenderer((element) => {
    const root = createRoot(element);
    root.render(<StarCards />);
    // The view's root is committing as it lets go of the element; this one unmounts after it.
    return () => queueMicrotask(() => root.unmount());
  });

  detailsCards.setTrayRenderer((element) => {
    const root = createRoot(element);
    root.render(<DetailsTray />);
    return () => queueMicrotask(() => root.unmount());
  });

  const panel = fileDetailsPanel(layout, groups);
  update = () => {
    const editor = editors.activeEditor;
    const file =
      EditorResourceAccessor.getCanonicalUri(editor, {
        supportSideBySide: SideBySideEditor.PRIMARY,
        filterByScheme: [PULT_SCHEME, "pult-diff", "file", "untitled"],
      }) !== undefined;
    const view = file ? selectedTarget() : threadViewOf(editor);
    const cards = view === null ? null : cardsOver(view, editor);
    availableKey.set(file ? cards !== null : view !== null);
    const shown =
      open && cards !== null ? (file ? { ...cards, fileRows: panel.rows } : cards) : null;
    detailsCards.set(shown);
    panel.show(file ? shown : null);
  };
  editors.onDidActiveEditorChange(update);
  onDidSelectThread(update);
  threadStore.subscribe(update);
  starStore.subscribe(update);
  update();
}
