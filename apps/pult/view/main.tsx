// The thread view the page mounts in its thread pane (`src/threads/pane.tsx`):
// upstream's turns and composer from `apps/web`, with the app around them ours
// (`ThreadView.tsx`), on the page's connection, its React, Effect and the
// repository's packages the page's own.
import "./tailwind.css";
import "./shell.css";

import {
  readAppearanceModePreference,
  readThemePreference,
  refreshTheme,
  setAppearanceMode,
  setSystemColorSchemeSource,
  setTheme,
} from "~/hooks/useTheme";
import { setServerRuntimeOffPrimary } from "~/browser/previewRuntime";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { startI18n } from "~/i18n/runtime";
import { subscribeDraftThreadPromotion } from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { startBrowserHost } from "./browserHost.tsx";
import { isPromotion } from "./drafts.ts";
import { setThreadViewHost, type ThreadViewHost } from "./host.ts";
import {
  closePreviewSession,
  followPreviewSessions,
  openFileInPreview,
  previewSessions,
  startPreviews,
  type ThreadPreviewSessions,
} from "./preview.ts";
import { type MountedPreview, mountPreview, type PreviewMountOptions } from "./PreviewMount.tsx";
import { mountReaderSelection } from "./ReaderSelection.tsx";
import { routeRightPanel } from "./rightPanel.ts";
import { toggleTerminal } from "./terminal.ts";
import {
  type MountedView,
  type MountOptions,
  mountComposerView,
  mountDraftView,
  mountThreadView,
  type ViewTarget,
} from "./ThreadView.tsx";

export type {
  DetailsCards,
  DetailsCardsTarget,
  DetailsCardsValue,
  ThreadViewHost,
  TurnCheckpoints,
} from "./host.ts";
export type { ShellConnectionServices } from "./connectionRuntime.ts";
export type { MountedView, MountOptions, ViewTarget } from "./ThreadView.tsx";
export type { PreviewOwner, PreviewSessionInfo, ThreadPreviewSessions } from "./preview.ts";
export type { MountedPreview, PreviewMountOptions } from "./PreviewMount.tsx";

export interface ThreadViewMounts {
  /** The thread's turns and composer, on its environment. */
  mount(
    element: HTMLElement,
    environmentId: string,
    threadId: string,
    options?: MountOptions,
  ): MountedView;
  /**
   * The project's draft of a new thread, upstream's composer, which stays
   * mounted as the thread it creates and names it to `onPromoted`, with the
   * environment the composer created it on.
   */
  mountDraft(
    element: HTMLElement,
    target: Extract<ViewTarget, { kind: "draft" }>,
    onPromoted: (environmentId: string, threadId: string) => void,
    options?: MountOptions,
  ): MountedView;
  /** The composer alone of a thread or a project's draft, for the strip under a file. */
  mountComposer(element: HTMLElement, target: ViewTarget, options?: MountOptions): MountedView;
  /**
   * Whether the server thread `threadId` on `environmentId` is the one the
   * project's draft on `draftEnvironmentId` creates, before the view mounted
   * for that draft has been promoted to it (`mountDraft`'s `onPromoted`).
   */
  draftCreates(
    draft: Extract<ViewTarget, { kind: "draft" }>,
    environmentId: string,
    threadId: string,
  ): boolean;
  /**
   * Upstream's preview pane for the thread's session `tabId`, or with a null
   * `tabId` a placeholder for a new one (`PreviewMount.tsx`), for the shell's
   * preview tab; the host's `openPreview` names what to mount.
   */
  /** The thread's selection action on a reader's page (`ReaderSelection.tsx`). */
  mountReaderSelection: typeof mountReaderSelection;
  /** The chat's line wrap for code, which the reader's code follows. */
  codeWrap(): boolean;
  /** Calls `listener` when `codeWrap` changes; returns its removal. */
  onDidChangeCodeWrap(listener: () => void): () => void;
  mountPreview(
    element: HTMLElement,
    environmentId: string,
    threadId: string,
    tabId: string | null,
    options?: PreviewMountOptions,
  ): MountedPreview;
  /** The thread's live preview sessions, with their owners and labels, as the view knows them now. */
  previewSessions(environmentId: string, threadId: string): ThreadPreviewSessions;
  /**
   * The same, at once and on each change until the returned stop, the
   * thread's list kept in step with its server meanwhile: a tab's label and
   * icon, and Open Browser's pick.
   */
  followPreviewSessions(
    environmentId: string,
    threadId: string,
    listener: (sessions: ThreadPreviewSessions) => void,
  ): () => void;
  /** Opens a file in a new browser session of the thread, its scripts running (`preview.ts`); why it did not, if it did not. */
  openFileInPreview(
    environmentId: string,
    threadId: string,
    path: string,
    workspaceRoot: string | undefined,
  ): Promise<string | undefined>;
  /** Ends a session on its server (Close Browser Session, a user's tab closed); whether it ended. */
  closePreviewSession(environmentId: string, threadId: string, tabId: string): Promise<boolean>;
  /**
   * Toggles the thread's terminal drawer, upstream's, in its mounted view, or
   * with `open` opens it (`terminal.ts`); whether a mounted view took it.
   */
  toggleTerminal(environmentId: string, threadId: string, open: boolean): boolean;
}

/**
 * Starts the view on the page's connection; call once, before any pane
 * mounts, then mount a thread or a project's draft per pane. The view takes
 * the host's colour scheme as the system's and follows it: upstream's own
 * appearance preference, kept in localStorage, is set back to System, since
 * the shell offers no page to change it and a stale Light or Dark there
 * would paint the view's text in one scheme on the workbench's other. Its
 * files open in the shell (`rightPanel.ts`), and so do the preview browsers
 * an agent reveals or the user opens (`preview.ts`). In Pult.app it hosts the
 * preview sessions' webviews page-wide (`browserHost.tsx`). The shell starts
 * it at boot in Pult.app, so an agent's browser attaches with no pane open.
 */
export function startThreadView(host: ThreadViewHost): ThreadViewMounts {
  setThreadViewHost(host);
  // Upstream's strings read GT, which its app starts as it boots; the view's roots each carry its provider.
  startI18n();
  routeRightPanel();
  startPreviews();
  // Drafts promote as their server threads arrive, as upstream's app starts it: a draft's route follows the redirect its finalization leaves, which is how a pane's draft becomes its thread.
  subscribeDraftThreadPromotion({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.quietThreadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
  });
  // A user's browser tab opens in the server's runtime wherever the server has one, so the agent can drive it.
  setServerRuntimeOffPrimary(true);
  setSystemColorSchemeSource({
    isDark: () => host.colorScheme() === "dark",
    onChange: host.onDidChangeColorScheme,
  });
  if (readThemePreference() !== "system") setTheme("system");
  if (readAppearanceModePreference("system") !== "system") setAppearanceMode("system");
  // Upstream applies its theme as its module loads, which is before this, by the browser's scheme.
  refreshTheme();
  // Upstream hears the system's scheme only while a component reads the theme, and a view no pane shows unmounts its own, so the page follows it itself.
  host.onDidChangeColorScheme(() => refreshTheme());
  startBrowserHost(host.keepRendering);
  return {
    mount: mountThreadView,
    mountDraft: mountDraftView,
    mountComposer: mountComposerView,
    draftCreates: isPromotion,
    mountPreview,
    mountReaderSelection,
    codeWrap: () => getClientSettings().wordWrap,
    onDidChangeCodeWrap: (listener) => {
      let wrap = getClientSettings().wordWrap;
      return subscribeClientSettings(() => {
        if (getClientSettings().wordWrap === wrap) return;
        wrap = getClientSettings().wordWrap;
        listener();
      });
    },
    previewSessions,
    followPreviewSessions,
    closePreviewSession,
    openFileInPreview,
    toggleTerminal,
  };
}
