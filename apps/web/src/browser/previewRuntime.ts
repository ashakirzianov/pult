import { useAtomValue } from "@effect/atom-react";
import {
  allowsPreviewTunnel,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";

import { tunnelsEnvironmentLoopback } from "./browserTargetResolver";

/** Whether this desktop loads the environment's localhost itself: it is local, or its tunnel is on. */
const desktopLoadsLoopbackAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const target = get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target;
    if (!tunnelsEnvironmentLoopback(target)) return true;
    const config = get(environmentServerConfigsAtom).get(environmentId);
    return config !== undefined && allowsPreviewTunnel(config);
  }).pipe(Atom.withLabel(`preview:desktop-loads-loopback:${environmentId}`)),
);

/**
 * Pult's hook point, not upstream's: Pult's shell opens a browser tab in the
 * server's runtime on every environment whose server has a browser, the
 * primary's or not, so the agent can drive the tab the user opened. Unset,
 * upstream's rule: off the primary, a desktop app opens desktop tabs.
 */
let serverRuntimeOffPrimary = false;

/** Pult's hook point, not upstream's: see `serverRuntimeOffPrimary`. */
export function setServerRuntimeOffPrimary(enabled: boolean): void {
  serverRuntimeOffPrimary = enabled;
}

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  // Without its tunnel, another environment's tabs stream from it, as on the web.
  if (
    !serverRuntimeOffPrimary &&
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom) &&
    appAtomRegistry.get(desktopLoadsLoopbackAtom(environmentId))
  ) {
    return undefined;
  }
  return "server";
}

/**
 * Pult's hook point, not upstream's: a session opened now goes to the server's
 * runtime under `serverRuntimeOffPrimary`, so a local server's URL stays the
 * server's own `localhost` (as `openDiscoveredPort`'s). Unset, false.
 */
export function opensServerTabByPolicy(environmentId: EnvironmentId): boolean {
  return serverRuntimeOffPrimary && previewRuntimeFor(environmentId) === "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  desktopLoadsLoopback: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  if (snapshot.runtime === "server") return desktopLoadsLoopback ? "desktop" : null;
  return "server";
}

export function useDesktopLoadsLoopback(environmentId: EnvironmentId): boolean {
  return useAtomValue(desktopLoadsLoopbackAtom(environmentId));
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
