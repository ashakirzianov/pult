// Stands in for `apps/web`'s `src/keybindings.ts` (`./stubs.ts`): upstream's
// shortcuts, which its handlers resolve on the window wherever focus is, fire
// only while the keyboard is the view's, and leave the workbench the chords
// it keeps. Every other export is upstream's.
import * as Upstream from "~/keybindings";

export * from "~/keybindings";

/**
 * The view's elements in the page: the roots the shell mounts it in
 * (`ThreadView.tsx`, `PreviewMount.tsx`, `browserHost.tsx`), the Details
 * column's element its thread details render into (`ThreadDetailsCard.tsx`)
 * and base-ui's portal node for its popovers, menus and dialogs.
 */
const VIEW_ELEMENTS = ".pult-thread-view, .pult-view-theme, [data-base-ui-portal]";

/**
 * The view's chords that are the workbench's in Pult: Cmd+Shift+P, the
 * Command Palette, over Pin Thread; Cmd+Shift+S, Save As, over Settle
 * Thread, which would settle in place, bypassing the shell's move to the next
 * card; Cmd+Shift+G, Source Control, over the branch picker. By key, so a
 * user's own binding of those commands elsewhere still works, in the composer
 * too, whose strikethrough gives Cmd+Shift+S up (`ThreadView.tsx`).
 */
const WORKBENCH_CHORDS = new Set(["KeyP", "KeyS", "KeyG"]);

function isViewKey(event: Upstream.ShortcutEventLike): boolean {
  const target = event.target ?? document.activeElement;
  if (!(target instanceof Element) || target.closest(VIEW_ELEMENTS) === null) return false;
  const code = event.code ?? `Key${event.key.toUpperCase()}`;
  // Cmd+Alt+B, upstream's right panel toggle, is Pult: Show and Hide Details (`src/details/`).
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.altKey && !event.shiftKey && code === "KeyB") return false;
  if (!mod || !event.shiftKey || event.altKey) return true;
  if (!WORKBENCH_CHORDS.has(code)) return true;
  // An open project list keeps Cmd+Shift+P, which pins its highlighted project.
  return code === "KeyP" && target.closest('[role="combobox"][aria-expanded="true"]') !== null;
}

export const resolveShortcutCommand: typeof Upstream.resolveShortcutCommand = (event, ...rest) =>
  isViewKey(event) ? Upstream.resolveShortcutCommand(event, ...rest) : null;

export const resolveChatShortcutCommand: typeof Upstream.resolveChatShortcutCommand = (
  event,
  ...rest
) => (isViewKey(event) ? Upstream.resolveChatShortcutCommand(event, ...rest) : null);

/** Upstream's matchers of one command's shortcut, gated as the resolvers are. */
function gated<Rest extends unknown[]>(
  matches: (event: Upstream.ShortcutEventLike, ...rest: Rest) => boolean,
) {
  return (event: Upstream.ShortcutEventLike, ...rest: Rest) =>
    isViewKey(event) && matches(event, ...rest);
}

export const isTerminalToggleShortcut: typeof Upstream.isTerminalToggleShortcut = gated(
  Upstream.isTerminalToggleShortcut,
);
export const isTerminalSplitShortcut: typeof Upstream.isTerminalSplitShortcut = gated(
  Upstream.isTerminalSplitShortcut,
);
export const isTerminalSplitVerticalShortcut: typeof Upstream.isTerminalSplitVerticalShortcut =
  gated(Upstream.isTerminalSplitVerticalShortcut);
export const isTerminalNewShortcut: typeof Upstream.isTerminalNewShortcut = gated(
  Upstream.isTerminalNewShortcut,
);
export const isTerminalCloseShortcut: typeof Upstream.isTerminalCloseShortcut = gated(
  Upstream.isTerminalCloseShortcut,
);
export const isDiffToggleShortcut: typeof Upstream.isDiffToggleShortcut = gated(
  Upstream.isDiffToggleShortcut,
);
export const isOpenFavoriteEditorShortcut: typeof Upstream.isOpenFavoriteEditorShortcut = gated(
  Upstream.isOpenFavoriteEditorShortcut,
);
