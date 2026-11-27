// Upstream's right panel in Pult's shell: a file the view would open there
// opens as an editor tab of the shell's instead, its diff surface is the
// shell's changes view, and the thread details card opens only as the
// shell's details cards show (`ThreadDetailsPanel.tsx`), never by upstream's
// toggles. A thread it would show as a tab, a side chat or a subagent, opens
// in the shell, a side chat as a tab among its parent's (`pult/decisions`,
// `side-chats`). The panel's store is Zustand's, its actions fields of the state,
// so the shell's build replaces them at start and stubs nothing. What the panel
// still holds, pull requests, devices, terminals, stays its own until the
// shell gives each a place.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { threadViewHost } from "./host.ts";
import { turnCheckpoints } from "./turnCheckpoints.ts";

/**
 * The thread upstream last showed in a thread's panel, a side chat or a
 * subagent, that panel's thread, and until when the view's navigation to that
 * thread is that showing's own: upstream shows a side chat in its parent's
 * panel, then goes to the parent when the click was in another thread
 * (`resolveThreadOpenRoute`), which in the shell would select the parent again
 * over the side chat's tab.
 */
let shownIn: { readonly key: string; readonly shown: string; readonly until: number } | undefined;

/** How long after a thread shows in a panel the view's navigation to that panel's thread follows it. */
const SHOWING_FOLLOWS_MS = 2000;

/**
 * Whether the view's navigation to `ref` follows upstream's showing of a side
 * chat or a subagent in its panel, which the shell has opened already: true
 * once, then the navigation is the view's own again. Never from the view of
 * the thread shown, whose link to its parent is the reader's own.
 */
export function followsShowingIn(ref: ScopedThreadRef, from: string | null): boolean {
  const showing = shownIn;
  if (showing === undefined || showing.key !== scopedThreadKey(ref) || from === showing.shown)
    return false;
  shownIn = undefined;
  return performance.now() <= showing.until;
}

/**
 * Once, before any view mounts: files and the diff go to the shell, a
 * thread upstream shows in a panel opens in the shell, a turn's completion
 * opens no panel, upstream's toggles of the thread details card do nothing.
 */
export function routeRightPanel(): void {
  const { open, openProactive } = useRightPanelStore.getState();
  useRightPanelStore.setState({
    openFile: (ref, path, line, endLine) =>
      threadViewHost().openFile(
        ref.environmentId,
        ref.threadId,
        path,
        line ?? null,
        endLine ?? null,
      ),
    open: (ref, kind) => {
      if (kind !== "diff") return open(ref, kind);
      // The view selects the turn and its file in the diff store before opening the surface.
      const selection = selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        ref,
      );
      threadViewHost().openChanges(
        ref.environmentId,
        ref.threadId,
        selection.kind === "turn" ? selection.filePath : null,
        selection.kind === "turn" ? turnCheckpoints(ref, selection.turnId) : null,
      );
    },
    openThread: (ref, threadId) => {
      shownIn = {
        key: scopedThreadKey(ref),
        shown: threadId,
        until: performance.now() + SHOWING_FOLLOWS_MS,
      };
      threadViewHost().openThread(ref.environmentId, threadId);
    },
    openProactive: (ref, surface, revision) =>
      surface.kind === "diff" ? false : openProactive(ref, surface, revision),
    setThreadPanelOpen: () => {},
    toggleThreadPanel: () => {},
  });
}

/**
 * Whether the thread's details card is open inline, which the chat's canvas
 * clears its lane of: the details cards' stub writes it as they show.
 */
export function setThreadPanelInline(ref: ScopedThreadRef, open: boolean): void {
  const key = scopedThreadKey(ref);
  useRightPanelStore.setState((state) => ({
    threadPanelVisibilityByThreadKey: {
      ...state.threadPanelVisibilityByThreadKey,
      [key]: { inlineOpen: open, popoverOpen: false },
    },
  }));
}
