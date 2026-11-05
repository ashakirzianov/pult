// What upstream's preview outlets become in Pult's shell (`preview.ts` swaps
// them in): a browser the view would float over the chat (the mini-player),
// show in its right panel or reveal there is a workbench tab of the shell's
// instead, and the reconcile that gives every session a panel tab only closes
// the tabs whose session ended (`pult/decisions`, `preview-tabs`). Devices
// keep upstream's actions. Imports nothing of `apps/web` at run time, so the
// decisions are tested under `node --test`.
import type { PreviewSessionSnapshot } from "@t3tools/contracts";

import type { ThreadViewHost } from "./host.ts";

/** A thread, as upstream's `ScopedThreadRef` names it. */
interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

/** Upstream's mini-player source, a browser tab's or a device's. */
type FloatSource = { readonly kind: "browser"; readonly tabId: string } | { readonly kind: string };

type PreviewHost = Pick<ThreadViewHost, "openPreview" | "closeStalePreviews">;

/** Upstream's actions the reroutes stand in for, for what stays upstream's. */
interface UpstreamOutlets<Ref extends ThreadRef, Source extends FloatSource> {
  readonly float: (ref: Ref, source: Source) => void;
  readonly revealSurface: (ref: Ref, surfaceId: string) => void;
}

const BROWSER_SURFACE = "browser:";
const PLACEHOLDER_SURFACE = "browser:new";

const tabKey = (ref: ThreadRef, tabId: string) =>
  `${ref.environmentId}\u0000${ref.threadId}\u0000${tabId}`;

/**
 * The reroutes, over the shell's host, the thread's session as the view
 * knows it, and upstream's actions.
 *
 * Upstream's reveal (`revealServerTabs`) floats a revealed session that has
 * no panel tab, and with no panel tabs in Pult that is every reveal; it does
 * not pass on whether the reveal was forced, so the float reads the session's
 * own reveal request: a request not seen before is the reveal, which opens the
 * session's tab in the background, or activates it when forced (the agent's
 * explicit open); a float with no new request is the user's (the view's
 * picture-in-picture button), which activates the tab. An unforced reveal of
 * a session whose tab is open is the shell's no-op (`openPreview`).
 */
export function previewRoutes<Ref extends ThreadRef, Source extends FloatSource>(deps: {
  readonly host: () => PreviewHost;
  readonly session: (
    ref: Ref,
    tabId: string,
  ) => Pick<PreviewSessionSnapshot, "reveal" | "revealRequest"> | undefined;
  readonly upstream: UpstreamOutlets<Ref, Source>;
}) {
  /** Per session, the reveal last turned into a tab, so a float of the same one again is the user's. */
  const revealed = new Map<string, string>();

  const openBrowser = (ref: Ref, tabId: string | null) =>
    deps.host().openPreview(ref.environmentId, ref.threadId, tabId, {
      activate: true,
      replacePlaceholder: tabId !== null,
    });

  return {
    /** The mini-player's `open`: a browser source opens its tab, a device floats as upstream's. */
    float(ref: Ref, source: Source): void {
      if (source.kind !== "browser" || !("tabId" in source)) {
        deps.upstream.float(ref, source);
        return;
      }
      const tabId = source.tabId;
      const session = deps.session(ref, tabId);
      // A session revealed with no request is one the server announced revealed as it opened.
      const reveal =
        session?.revealRequest?.id ?? (session?.reveal === true ? "opened" : undefined);
      const key = tabKey(ref, tabId);
      if (reveal !== undefined && revealed.get(key) !== reveal) {
        revealed.set(key, reveal);
        deps.host().openPreview(ref.environmentId, ref.threadId, tabId, {
          activate: session?.revealRequest?.force === true,
        });
        return;
      }
      deps.host().openPreview(ref.environmentId, ref.threadId, tabId, { activate: true });
    },
    /**
     * The right panel's `openBrowser`, the user's ways in (a link, a popup, a
     * moved tab, New): the session's tab, active, in place of the thread's
     * placeholder as upstream's replaces its `browser:new`; a null tab id the
     * placeholder itself.
     */
    openBrowser,
    /** The right panel's `revealSurface`: a browser surface's session's tab, active; the rest upstream's. */
    revealSurface(ref: Ref, surfaceId: string): void {
      if (!surfaceId.startsWith(BROWSER_SURFACE)) {
        deps.upstream.revealSurface(ref, surfaceId);
        return;
      }
      if (surfaceId === PLACEHOLDER_SURFACE) return;
      deps
        .host()
        .openPreview(ref.environmentId, ref.threadId, surfaceId.slice(BROWSER_SURFACE.length), {
          activate: true,
        });
    },
    /**
     * The right panel's `reconcileBrowserSurfaces`, with every live session of
     * the thread (those upstream keeps out of its panel included): no session
     * gets a tab by existing, a tab whose session ended closes.
     */
    reconcileBrowserSurfaces(ref: Ref, tabIds: ReadonlyArray<string>): void {
      const live = new Set(tabIds.map((tabId) => tabKey(ref, tabId)));
      const prefix = tabKey(ref, "");
      for (const key of revealed.keys()) {
        if (key.startsWith(prefix) && !live.has(key)) revealed.delete(key);
      }
      deps.host().closeStalePreviews(ref.environmentId, ref.threadId, tabIds);
    },
  };
}
