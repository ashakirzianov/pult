import { getService, IThemeService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";

import type { PultDesktop } from "./api.ts";

/**
 * The desktop's title strip. On macOS the wrapper draws no title bar
 * (`desktop/src/main.ts`), so the window's traffic lights sit over the page,
 * and the page leaves them a strip above the workbench, in the theme's title
 * bar colour, which drags the window as a title bar does. The strip goes
 * while the window is full screen, where macOS hides the lights. Nothing
 * where the wrapper reports no inset: a frame of the OS's own.
 */
export function installDesktopTitleBar(desktop: PultDesktop): void {
  const { titleBar } = desktop;
  if (titleBar.inset === 0) return;
  const strip = document.createElement("div");
  strip.className = "pult-titlebar";
  document.body.prepend(strip);

  const apply = (fullScreen: boolean) => {
    document.documentElement.style.setProperty("--pult-titlebar-inset", fullScreen ? "0px" : `${titleBar.inset}px`);
    // The resize that comes with full screen may have laid the workbench out before this reached the page.
    void getService(IWorkbenchLayoutService).then((layout) => layout.layout());
  };
  apply(false);
  void titleBar.isFullScreen().then(apply);
  titleBar.onFullScreenChange(apply);

  // The theme's colours live on the workbench's container, which the strip is outside of.
  void getService(IThemeService).then((themes) => {
    const paint = () => {
      const theme = themes.getColorTheme();
      strip.style.background = theme.getColor("titleBar.activeBackground")?.toString() ?? "";
      strip.style.borderBottomColor = theme.getColor("titleBar.border")?.toString() ?? "transparent";
    };
    paint();
    themes.onDidColorThemeChange(paint);
  });
}
