/**
 * Chords the thread view binds but the workbench keeps: Cmd+Shift+P, the
 * Command Palette, over the view's Pin Thread, and Cmd+Shift+G, Source
 * Control, over its branch picker. The view's shortcuts listen capturing on
 * the window and stop what they run, so the workbench's listener, bubbling
 * on the window, would never see these. Capturing ahead of the view (it loads
 * after boot), the page marks the event handled, which the view's listener
 * leaves alone, and lets it go on to the workbench, which resolves it as any
 * other key, a user's own keybindings included. An open project list in the
 * view keeps Cmd+Shift+P, which pins its highlighted project there.
 */
export function yieldWorkbenchKeys(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.code !== "KeyP" && event.code !== "KeyG") return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.code === "KeyP" && target?.closest('[role="combobox"][aria-expanded="true"]'))
        return;
      event.preventDefault();
    },
    true,
  );
}
