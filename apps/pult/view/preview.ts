// Upstream's preview browser in Pult's shell (`pult/decisions`, `preview-tabs`):
// the browsers an agent reveals and the user opens are the shell's workbench
// tabs, not upstream's mini-player over the chat or its right panel. The
// stores' actions are Zustand state fields, swapped at start as
// `rightPanel.ts` swaps files and the diff (`previewRoutes.ts` decides), and
// upstream's follower of every thread's sessions runs once their outlets go
// to the shell. Devices stay the view's.
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";

import { startAgentOpenedPreviews } from "~/components/preview/agentOpenedPreviews";
import { closePreviewSession as closeUpstreamSession } from "~/components/preview/closePreviewSession";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { previewStateAtom, type ThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsServerBrowser,
} from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { previewEnvironment } from "~/state/preview";
import { threadViewHost } from "./host.ts";
import { syncPreviewSessions } from "./PreviewMount.tsx";
import { previewRoutes } from "./previewRoutes.ts";

const threadRef = (environmentId: string, threadId: string) =>
  scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));

const readState = (environmentId: string, threadId: string) =>
  appAtomRegistry.get(previewStateAtom(scopedThreadKey(threadRef(environmentId, threadId))));

/** Upstream's preview surfaces the right panel remembers, persisted before the reroutes or since: none is shown. */
function dropPanelBrowserSurfaces(reconcile: (ref: ReturnType<typeof threadRef>) => void): void {
  for (const [key, state] of Object.entries(useRightPanelStore.getState().byThreadKey)) {
    const ref = parseScopedThreadKey(key);
    if (ref !== null && state.surfaces?.some((surface) => surface.kind === "preview"))
      reconcile(ref);
  }
}

let started = false;

/**
 * Once, before any view mounts: the outlets go to the shell's host
 * (`openPreview`, `closeStalePreviews`), then upstream's follower starts.
 */
export function startPreviews(): void {
  if (started) return;
  started = true;
  const panel = useRightPanelStore.getState();
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const routes = previewRoutes({
    host: threadViewHost,
    session: (ref, tabId) =>
      appAtomRegistry.get(previewStateAtom(scopedThreadKey(ref))).sessions[tabId],
    upstream: { float: miniPlayer.open, revealSurface: panel.revealSurface },
  });
  // Upstream's reconcile with no session keeps every surface but the browsers'.
  // A thread whose only surfaces were browsers' would keep its panel open on an empty picker.
  const dropBrowsers = (ref: ReturnType<typeof threadRef>) => {
    panel.reconcileBrowserSurfaces(ref, []);
    const left = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
    if (left?.isOpen === true && left.surfaces.length === 0) panel.close(ref);
  };
  usePreviewMiniPlayerStore.setState({ open: routes.float });
  useRightPanelStore.setState({
    openBrowser: routes.openBrowser,
    revealSurface: routes.revealSurface,
    reconcileBrowserSurfaces: (ref, tabIds) => {
      routes.reconcileBrowserSurfaces(ref, tabIds);
      const surfaces = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces;
      if (surfaces?.some((surface) => surface.kind === "preview")) dropBrowsers(ref);
    },
  });
  dropPanelBrowserSurfaces(dropBrowsers);
  startAgentOpenedPreviews();
}

/** Who controls a session's browser: an agent's, the user's, or no one's yet. */
export type PreviewOwner = "agent" | "human" | "unclaimed";

/** A live preview session of a thread, as the shell's tab and its Open Browser pick show it. */
export interface PreviewSessionInfo {
  readonly tabId: string;
  /**
   * The agent's when an agent opened it (`automationOwner`) or controls it
   * now; the user's when the user controls it; else unclaimed. Closing an
   * agent's tab only dismisses it; closing another ends its session.
   */
  readonly owner: PreviewOwner;
  /** The page's title, else its host, else "Browser", as upstream's panel tab names it. */
  readonly label: string;
  readonly url: string | null;
  /**
   * The page's favicon: the one the desktop captured for the page's origin,
   * else a public favicon service's for a public host; null before a page,
   * for a globe.
   */
  readonly favicon: string | null;
  readonly runtime: "desktop" | "server";
}

/**
 * A thread's live preview sessions, in the order the view learned of them. `loaded` is false
 * until the thread's first list arrived from a server with the server browser,
 * when an absent session is not yet an ended one.
 */
export interface ThreadPreviewSessions {
  readonly loaded: boolean;
  readonly sessions: ReadonlyArray<PreviewSessionInfo>;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function sessionLabel(snapshot: PreviewSessionSnapshot): string {
  if (snapshot.navStatus._tag === "Idle") return "Browser";
  if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
  try {
    return new URL(snapshot.navStatus.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function sessionInfo(
  state: ThreadPreviewState,
  snapshot: PreviewSessionSnapshot,
): PreviewSessionInfo {
  const desktop = state.desktopByTabId[snapshot.tabId];
  const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  const captured =
    desktop?.favicon && url !== null && sameOrigin(desktop.favicon.pageUrl, url)
      ? desktop.favicon.dataUrl
      : null;
  return {
    tabId: snapshot.tabId,
    owner:
      snapshot.automationOwner !== undefined || desktop?.controller === "agent"
        ? "agent"
        : desktop?.controller === "human"
          ? "human"
          : "unclaimed",
    label: sessionLabel(snapshot),
    url,
    favicon: captured ?? faviconUrlForOrigin(url, 32),
    runtime: snapshot.runtime ?? "desktop",
  };
}

function threadSessions(environmentId: string, state: ThreadPreviewState): ThreadPreviewSessions {
  const environment = EnvironmentId.make(environmentId);
  return {
    // Before its server config arrives an environment's server browser is unknown, so nothing is loaded yet.
    loaded:
      state.listLoaded ||
      (readEnvironmentServerConfigLoaded(environment) &&
        !readEnvironmentSupportsServerBrowser(environment)),
    sessions: Object.values(state.sessions).map((snapshot) => sessionInfo(state, snapshot)),
  };
}

/** The thread's live preview sessions as the view knows them now. */
export function previewSessions(environmentId: string, threadId: string): ThreadPreviewSessions {
  return threadSessions(environmentId, readState(environmentId, threadId));
}

/**
 * Calls `listener` with the thread's live preview sessions, at once and on
 * each change, until the returned stop; while followed, the thread's list
 * stays in step with its server, as while its pane shows it.
 */
export function followPreviewSessions(
  environmentId: string,
  threadId: string,
  listener: (sessions: ThreadPreviewSessions) => void,
): () => void {
  const stopSync = syncPreviewSessions(environmentId, threadId);
  const emit = () => listener(previewSessions(environmentId, threadId));
  const stop = appAtomRegistry.subscribe(
    previewStateAtom(scopedThreadKey(threadRef(environmentId, threadId))),
    emit,
    { immediate: true },
  );
  // Whether the server has a browser at all is its config's, which may arrive later.
  const stopConfigs = appAtomRegistry.subscribe(environmentServerConfigsAtom, emit);
  return () => {
    stop();
    stopConfigs();
    stopSync();
  };
}

/**
 * Ends the session on its server, as upstream's panel tab's close does: gone
 * from the view at once, back if the server refuses; whether it ended.
 */
export async function closePreviewSession(
  environmentId: string,
  threadId: string,
  tabId: string,
): Promise<boolean> {
  const ref = threadRef(environmentId, threadId);
  const result = await closeUpstreamSession({
    closePreview: (input) => runAtomCommand(appAtomRegistry, previewEnvironment.close, input),
    snapshot: readState(environmentId, threadId).sessions[tabId] ?? null,
    tabId,
    threadRef: ref,
  });
  return result._tag === "Success";
}
