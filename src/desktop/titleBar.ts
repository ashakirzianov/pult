import type { PultDesktop } from "./api.ts";

/**
 * The desktop's title bar, merged into the page. On macOS the wrapper draws
 * none (`desktop/src/main.ts`), so the window's traffic lights sit over the
 * page's top-left, in its top row: the left panel's header, or with the
 * panel collapsed the top-left editor group's tabs row. The page leaves
 * them `--pult-traffic-lights` at that row's start (`src/panel/panel.css`,
 * `src/style.css`), and those rows drag the window as a title bar does. The
 * room goes while the window is full screen, where macOS hides the lights.
 * Nothing where the wrapper reports no lights: a frame of the OS's own.
 */
export function installDesktopTitleBar(desktop: PultDesktop): void {
  const { titleBar } = desktop;
  if (titleBar.lightsWidth === 0) return;
  const apply = (fullScreen: boolean) =>
    document.documentElement.style.setProperty("--pult-traffic-lights", fullScreen ? "0px" : `${titleBar.lightsWidth}px`);
  apply(false);
  void titleBar.isFullScreen().then(apply);
  titleBar.onFullScreenChange(apply);
}
