// Upstream's preview browser host in Pult.app: one `<webview>` per live
// preview session of every thread the page hosts natively (the primary
// environment's server tabs, `pult/decisions`, `primary-environment`, and
// desktop tabs), each `position: fixed` on the page's body, placed over the
// rect a `BrowserSurfaceSlot` publishes and parked offscreen while none does.
// The desktop's server waits for this host to attach a webview to an agent's
// new tab before it falls back to its headless Chrome.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ElectronBrowserHost, startElectronBrowserHost } from "~/browser/ElectronBrowserHost";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

let started = false;

/**
 * Once, with the view (again is nothing: the shell retries a view that
 * failed to start): the host in a React root of its own on the page's
 * body, outside every pane, as upstream keeps it outside its router, since
 * moving a webview in the DOM destroys its guest; and the desktop bridge's
 * page-lifetime listeners (the annotation theme, the agent's pointer, links
 * a page opens). Only where upstream's desktop bridge offers previews, which
 * is Pult.app: a browser tab and the thin wrapper start nothing.
 */
export function startBrowserHost(): void {
  if (started || window.desktopBridge?.preview === undefined) return;
  started = true;
  startElectronBrowserHost();
  const element = document.createElement("div");
  // Outside every view's root, so the view's variables come with a class of their own (`shell.css`).
  element.className = "pult-browser-host pult-view-theme";
  document.body.append(element);
  createRoot(element).render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
}
