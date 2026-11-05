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
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import type { ThreadViewHost } from "./host.ts";

let started = false;

/**
 * Once, with the view (again is nothing: the shell retries a view that
 * failed to start): the host in a React root of its own on the page's
 * body, outside every pane, as upstream keeps it outside its router, since
 * moving a webview in the DOM destroys its guest; and the desktop bridge's
 * page-lifetime listeners (the annotation theme, the agent's pointer, links
 * a page opens); and the window kept drawing for a capture
 * (`followCaptures`). Only where upstream's desktop bridge offers previews,
 * which is Pult.app: a browser tab and the thin wrapper start nothing.
 */
export function startBrowserHost(keepRendering: ThreadViewHost["keepRendering"]): void {
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
  followCaptures(element, keepRendering);
}

/**
 * While the desktop captures a hidden browser (an agent's `preview_snapshot`,
 * `usePreviewBridge`'s capture activity), upstream's host paints it behind
 * the app, but the capture needs two more things of the window: to render at
 * all while hidden, occluded or on another Space (`keepRendering`, which
 * holds off its background throttling), and to draw a frame, which it does
 * only for damage it can see, and the browser, wholly covered, makes none
 * (`pult-capturing`, a pixel nobody sees changing, `src/style.css`). Both
 * last as long as a capture, seconds; the first call, with none on, drops a
 * hold a reloaded page left.
 */
function followCaptures(
  element: HTMLElement,
  keepRendering: ThreadViewHost["keepRendering"],
): void {
  const capturing = () =>
    Object.values(useBrowserSurfaceStore.getState().activityByTabId).some((count) => count > 0);
  const apply = (on: boolean) => {
    element.classList.toggle("pult-capturing", on);
    void keepRendering?.(on).catch((error: unknown) => {
      console.warn("Pult could not keep the window rendering for a browser's capture.", error);
    });
  };
  let held = capturing();
  apply(held);
  useBrowserSurfaceStore.subscribe(() => {
    const next = capturing();
    if (next === held) return;
    held = next;
    apply(next);
  });
}
