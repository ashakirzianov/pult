/**
 * Lets a text field the shell renders show the browser's own context menu,
 * with its spelling suggestions, inside the workbench. VS Code cancels every
 * context menu event that reaches its container, as its parts draw menus of
 * their own; one on a field under `element` (an input, a textarea, or
 * contenteditable, as the thread view's composer is) is stopped here, below
 * that listener. A field that draws its own menu still cancels the event
 * itself. The desktop wrapper builds the menu the browser would show.
 */
export function allowNativeTextMenu(element: HTMLElement): void {
  element.addEventListener("contextmenu", (event) => {
    if (event.target instanceof HTMLElement && isTextField(event.target)) event.stopPropagation();
  });
}

function isTextField(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  );
}
