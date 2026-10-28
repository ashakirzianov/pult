// The thread view the page mounts in its thread pane (`src/threads/pane.tsx`):
// upstream's turns and composer from the copy (`../t3/`), with the app around
// them ours (`ThreadView.tsx`), on the page's connection, its React, Effect
// and vendored packages the page's own.
import "../t3/src/index.css";
import "./shell.css";

import { refreshTheme } from "../t3/src/hooks/useTheme";
import { setThreadViewHost, type ThreadViewHost } from "./host.ts";
import { routeRightPanel } from "./rightPanel.ts";
import { followColorScheme } from "./theme.ts";
import { type MountedView, mountDraftView, mountThreadView } from "./ThreadView.tsx";

export type { ThreadViewHost } from "./host.ts";
export type { ShellConnectionServices } from "./connectionRuntime.ts";
export type { MountedView } from "./ThreadView.tsx";

export interface ThreadViewMounts {
  /** The thread's turns and composer, on its environment. */
  mount(element: HTMLElement, environmentId: string, threadId: string): MountedView;
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
  ): MountedView;
}

/**
 * Starts the view on the page's connection; call once, before any pane
 * mounts, then mount a thread or a project's draft per pane. The view
 * follows the workbench's theme (`theme.ts`), and its files open in the
 * shell (`rightPanel.ts`).
 */
export function startThreadView(host: ThreadViewHost, workbench: Element): ThreadViewMounts {
  setThreadViewHost(host);
  routeRightPanel();
  followColorScheme(workbench, () => ["vs-dark", "hc-black"].some((name) => workbench.classList.contains(name)));
  // Upstream applies its theme as its module loads, which is before this, by the browser's scheme.
  refreshTheme();
  return { mount: mountThreadView, mountDraft: mountDraftView };
}
