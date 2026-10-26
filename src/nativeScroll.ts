/**
 * Lets an element the shell renders scroll natively inside the workbench.
 * VS Code cancels every wheel event that reaches its container, to block
 * macOS's back-and-forward swipe, since its own scrollers scroll by script;
 * a native `overflow: auto` under it never moves. A wheel event is stopped
 * here, below that listener, so the browser scrolls whatever the pointer is
 * over inside `element`. Horizontal overscroll is the element's own to
 * contain (`overscroll-behavior`).
 */
export function allowNativeScroll(element: HTMLElement): void {
  element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}
