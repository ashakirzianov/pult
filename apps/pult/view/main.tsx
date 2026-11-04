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
import { setThreadViewHost, type ThreadViewHost } from "./host.ts";
import { routeRightPanel } from "./rightPanel.ts";
import {
  isPromotion,
  type MountedView,
  type MountOptions,
  mountComposerView,
  mountDraftView,
  mountThreadView,
  type ViewTarget,
} from "./ThreadView.tsx";

export type { ThreadViewHost, TurnCheckpoints } from "./host.ts";
export type { ShellConnectionServices } from "./connectionRuntime.ts";
export type { MountedView, MountOptions, ViewTarget } from "./ThreadView.tsx";

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
    environmentId: string,
    projectId: string,
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
    draftEnvironmentId: string,
    projectId: string,
    environmentId: string,
    threadId: string,
  ): boolean;
}

/**
 * Starts the view on the page's connection; call once, before any pane
 * mounts, then mount a thread or a project's draft per pane. The view takes
 * the host's colour scheme as the system's and follows it: upstream's own
 * appearance preference, kept in localStorage, is set back to System, since
 * the shell offers no page to change it and a stale Light or Dark there
 * would paint the view's text in one scheme on the workbench's other. Its
 * files open in the shell (`rightPanel.ts`).
 */
export function startThreadView(host: ThreadViewHost): ThreadViewMounts {
  setThreadViewHost(host);
  routeRightPanel();
  setSystemColorSchemeSource({
    isDark: () => host.colorScheme() === "dark",
    onChange: host.onDidChangeColorScheme,
  });
  if (readThemePreference() !== "system") setTheme("system");
  if (readAppearanceModePreference("system") !== "system") setAppearanceMode("system");
  // Upstream applies its theme as its module loads, which is before this, by the browser's scheme.
  refreshTheme();
  return {
    mount: mountThreadView,
    mountDraft: mountDraftView,
    mountComposer: mountComposerView,
    draftCreates: (draftEnvironmentId, projectId, environmentId, threadId) =>
      isPromotion(
        { kind: "draft", environmentId: draftEnvironmentId, projectId },
        environmentId,
        threadId,
      ),
  };
}
