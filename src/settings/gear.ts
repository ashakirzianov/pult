import { getService, ICommandService } from "@codingame/monaco-vscode-api";

/**
 * The activity bar's gear, the workbench's Manage button, opens the Pult
 * settings page (`pult-shell.selectSettings`) instead of the Manage menu,
 * which the page offers from its VS Code section (`SettingsPage.tsx`). The
 * button is the workbench's own, listening for a left mouse-down, Enter and
 * Space on its item, so the shell takes those before it in the capture
 * phase on the document, where the bar can be built and rebuilt at will; a
 * right-click keeps the bar's own context menu. Registered before the
 * workbench starts.
 */
export function routeManageGear(): void {
  const isGear = (target: EventTarget | null) =>
    target instanceof Element &&
    target.closest(".part.activitybar .action-item")?.querySelector(".codicon-settings-view-bar-icon") != null;
  const open = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.selectSettings"));
  };
  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 2 && isGear(event.target)) open(event);
    },
    { capture: true },
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if ((event.key === "Enter" || event.key === " ") && isGear(event.target)) open(event);
    },
    { capture: true },
  );
}
