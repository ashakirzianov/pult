import { getService, IDialogService, INotificationService } from "@codingame/monaco-vscode-api";
import type { DesktopServerExposureMode } from "@t3tools/contracts";

import { desktopHost } from "./host.ts";
import { localServerEnabled } from "./localServer.ts";

/**
 * Pult.app's local server's network access (xaxis `pult/issues/pair-device`):
 * upstream's desktop setting, `local-only` or `network-accessible`, which
 * decides whether another device reaches it, so a pairing link of it works
 * there. Read from the app once something looks, `undefined` until then and
 * outside Pult.app or with its local server off. Tailscale serving stays
 * upstream's.
 */
let mode: DesktopServerExposureMode | undefined;
let reading = false;
const listeners = new Set<() => void>();

export const serverExposure = {
  get: () => mode,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    void read();
    return () => listeners.delete(listener);
  },
};

async function read(): Promise<void> {
  const host = desktopHost();
  if (host === undefined || localServerEnabled() !== true || reading || mode !== undefined) return;
  reading = true;
  try {
    mode = (await host.getServerExposureState()).mode;
    for (const listener of listeners) listener();
  } finally {
    reading = false;
  }
}

/** Asks, then sets the local server's network access, which relaunches Pult.app when it changes. */
export async function setNetworkAccess(reachable: boolean): Promise<void> {
  const host = desktopHost();
  const next = reachable ? "network-accessible" : "local-only";
  if (host === undefined || mode === next) return;
  const { confirmed } = await (
    await getService(IDialogService)
  ).confirm({
    message: reachable
      ? "Make this computer's server reachable from other devices?"
      : "Make this computer's server reachable from it alone?",
    detail: reachable
      ? "Pult restarts, and devices on your network can then reach the server; a device still needs a pairing link to connect."
      : "Pult restarts, and devices connected over your network disconnect. Other environments are unaffected.",
    primaryButton: reachable ? "Restart and Make Reachable" : "Restart and Make Local",
  });
  if (!confirmed) return;
  try {
    mode = (await host.setServerExposureMode(next)).mode;
    for (const listener of listeners) listener();
  } catch (error) {
    (await getService(INotificationService)).error(
      `Pult could not change the server's network access. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The addresses Pult.app advertises for its local server, for a pairing link of it (`src/connection/pairingLink.ts`). */
export function advertisedEndpoints() {
  return desktopHost()?.getAdvertisedEndpoints();
}
