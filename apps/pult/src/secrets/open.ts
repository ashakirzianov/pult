// A secret's card opened: its poster selected, as an ask's poster is, and the
// keyboard put in the secret card's input in the thread view, or left to the
// view's own focus, the composer, while none shows.
import { getService, ICommandService, INotificationService } from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { SimpleEditorPane } from "@codingame/monaco-vscode-workbench-service-override/common";

import { starById } from "../stars/model.ts";
import { USER_CHANNEL } from "../stars/plugin.ts";
import { starEnabled } from "../stars/settings.ts";
import { selectedStar, selectionTarget } from "../threads/selection.ts";
import { threadStore } from "../threads/store.ts";
import { secretOf } from "./model.ts";

/** A pending secret card's label in upstream's thread view (`SecretRequestCard.tsx`), whose control is the secret's field, not the source picker's: an answered card is a row with no form. */
const SECRET_LABEL = 'form[data-v2-item-type="secret_request"] label[for]';
/** How long the view is given to draw the card once its poster is shown. */
const FOCUS_WAIT_MS = 2_000;
/** The tag a Star gives every thread it launches, before the Star's id (`star-launched-threads`). */
const CHILD_TAG = "pult:child:star:";

const secretField = (container: HTMLElement) =>
  container.querySelector<HTMLLabelElement>(SECRET_LABEL)?.control ?? null;

/** The latest opening, which alone may still put the keyboard anywhere. */
let opening = 0;

/**
 * Puts the keyboard in the secret card's field inside `container` once the
 * view draws it, while `still` holds, giving up after a while: two frames
 * after it is drawn, since the view entering a thread gives the composer
 * focus a frame after its commit (upstream's `useFocusComposerOnThreadOpen`).
 */
function focusSecretInput(container: HTMLElement, still: () => boolean): void {
  const focus = () => {
    if (secretField(container) === null) return false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (still()) secretField(container)?.focus();
      }),
    );
    return true;
  };
  if (focus()) return;
  const observer = new MutationObserver(() => {
    if (!still() || focus()) stop();
  });
  const timer = setTimeout(() => stop(), FOCUS_WAIT_MS);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
  };
  observer.observe(container, { childList: true, subtree: true });
}

/** Whether the selection shows the thread: it, or its Star's. */
function shows(environmentId: string, threadId: string, starId: string | undefined): boolean {
  if (starId !== undefined) return selectedStar() === starId;
  const selection = selectionTarget();
  return (
    selection !== undefined &&
    "threadId" in selection &&
    selection.environmentId === environmentId &&
    selection.threadId === threadId
  );
}

/**
 * Opens the secret's card (`pult-shell.openSecret <environmentId> <threadId>`,
 * its card's click and a jump to it): its poster selected, a Star's open
 * conversation in `user` the Star, in another channel that channel's tab
 * among the Star's, any other of its threads (a conversation no channel holds
 * open now) as a tab of its own among the Star's, as a Star's child is while
 * Show Star is on, any other thread itself; then the keyboard in the card's
 * field.
 */
async function openSecret(environmentId: unknown, threadId: unknown): Promise<void> {
  if (typeof environmentId !== "string" || typeof threadId !== "string")
    throw new Error("pult-shell.openSecret takes an environment and a thread.");
  const secret = secretOf(environmentId, threadId);
  if (secret === undefined)
    return void (await getService(INotificationService)).info(
      "That secret is no longer asked for.",
    );
  const commands = await getService(ICommandService);
  const opened = ++opening;
  let starId: string | undefined;
  if ("star" in secret.poster) {
    starId = secret.poster.star;
    // By the thread itself: a channel's tab shows its open conversation, which may be another.
    const channel = starById(starId)?.channels.find(
      ({ thread }) => thread.environmentId === environmentId && thread.id === threadId,
    );
    if (channel?.slug === USER_CHANNEL)
      await commands.executeCommand("pult-shell.selectStar", starId);
    else if (channel !== undefined)
      await commands.executeCommand("pult-shell.openStarChannel", starId, channel.slug);
    else await commands.executeCommand("pult-shell.openStarChild", starId, environmentId, threadId);
  } else {
    const thread = threadStore
      .get()
      .threads.find((each) => each.environmentId === environmentId && each.id === threadId);
    const parent = thread?.tags
      .filter((tag) => tag.startsWith(CHILD_TAG))
      .map((tag) => tag.slice(CHILD_TAG.length))
      .find((id) => starById(id) !== undefined);
    if (parent !== undefined && starEnabled.get()) {
      starId = parent;
      await commands.executeCommand("pult-shell.openStarChild", parent, environmentId, threadId);
    } else await commands.executeCommand("pult-shell.selectThread", environmentId, threadId);
  }
  // A switch cancelled over a modified file leaves the selection as it was.
  if (!shows(environmentId, threadId, starId)) return;
  // The thread's tab, a Star's or its channel's or child's, each a pane of the shell's own.
  const editors = await getService(IEditorService);
  const pane = editors.activeEditorPane;
  const container = pane instanceof SimpleEditorPane ? pane.getContainer() : undefined;
  if (container !== undefined)
    focusSecretInput(
      container,
      () =>
        opened === opening &&
        editors.activeEditorPane === pane &&
        shows(environmentId, threadId, starId),
    );
}

/** `pult-shell.openSecret <environmentId> <threadId>`, not in the palette. Registered before the workbench starts. */
export function registerSecretCommands(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.openSecret",
          title: { value: "Open Secret Request", original: "Open Secret Request" },
          category: { value: "Pult", original: "Pult" },
        });
      }

      run(_: unknown, environmentId?: unknown, threadId?: unknown): Promise<void> {
        return openSecret(environmentId, threadId);
      }
    },
  );
}
