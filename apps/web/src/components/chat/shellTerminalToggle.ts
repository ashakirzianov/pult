// Pult: the app around the view toggles a thread's terminal drawer from its
// own command (Ctrl+`, a button in its tab bar), as the view's `terminal.toggle`
// shortcut does; the fork's own web app never requests one.

const toggles = new Map<string, () => void>();

/** Takes the shell's toggles of the thread's drawer, by its scoped key, until the returned stop. */
export function onShellTerminalToggle(threadKey: string, toggle: () => void): () => void {
  toggles.set(threadKey, toggle);
  return () => {
    if (toggles.get(threadKey) === toggle) toggles.delete(threadKey);
  };
}

/** Toggles the thread's drawer in its mounted view; whether a view took it. */
export function toggleShellTerminal(threadKey: string): boolean {
  const toggle = toggles.get(threadKey);
  if (toggle === undefined) return false;
  toggle();
  return true;
}
