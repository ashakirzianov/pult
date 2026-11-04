import type { PultDesktop } from "./api.ts";

/**
 * The desktop's title bar, merged into the page. On macOS the wrapper draws
 * none (`desktop/src/main.ts`), so the window's traffic lights sit over the
 * page's top-left, in its top row: the left panel's header, or with the
 * panel collapsed the top-left editor group's tabs row. The page leaves
 * them `--pult-traffic-lights` at that row's start (`src/panel/panel.css`,
 * `src/style.css`), and those rows drag the window as a title bar does. The
 * lights keep their size whatever the page's zoom, so the wrapper places
 * them again, and the room changes, as the zoom does (a zoom changes the
 * page's `devicePixelRatio`, as a move to a display of another scale does)
 * and as the window enters and leaves full screen, where macOS hides them.
 * No room where the wrapper reports none: a frame of the OS's own.
 */
export function installDesktopTitleBar(desktop: PultDesktop): void {
  const { titleBar } = desktop;
  const layout = () =>
    void titleBar
      .layout()
      .then((room) =>
        document.documentElement.style.setProperty("--pult-traffic-lights", `${room}px`),
      );
  const followZoom = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      followZoom,
      { once: true },
    );
    layout();
  };
  followZoom();
  titleBar.onFullScreenChange(layout);
}
