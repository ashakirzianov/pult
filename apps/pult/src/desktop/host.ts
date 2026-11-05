import type { DesktopBridge } from "@t3tools/contracts";

/**
 * Upstream's desktop bridge, `window.desktopBridge`, present when the page is
 * Pult.app's renderer (upstream's `apps/desktop` as its host, `pult/decisions`,
 * `desktop-wrapper`); absent in a browser tab and in the thin wrapper
 * (`desktop/`). `apps/web` declares it on `window` for its own build only.
 */
export function desktopHost(): DesktopBridge | undefined {
  return (window as { desktopBridge?: DesktopBridge }).desktopBridge;
}
