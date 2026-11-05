// The app around upstream's thread view in Pult's shell: one thread, or one
// project's draft, per pane, on the shell's connection. A draft follows itself
// into the thread it creates; a navigation to another thread or a new one
// opens it in the shell.
import { type AnyRouter, Outlet, RouterProvider, useRouter } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import {
  EnvironmentId,
  isOrchestrationV2WorkActive,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { type ReactNode, StrictMode, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import {
  ComposerControlsSlot,
  ComposerControlsSlotEntries,
} from "~/components/chat/ComposerFooterControls";
import { ConfirmDialogHost } from "~/components/ConfirmDialogHost";
import { CustomSnoozeDialogHost } from "~/components/CustomSnoozeDialog";
import { ShellComposerOptions, type ShellValue } from "~/components/chat/ShellComposerOptions";
import { TimelineHeaderSlot } from "~/components/chat/TimelineHeaderSlot";
import { SidebarProvider } from "~/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useProjects, useThreadProjection } from "~/state/entities";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { ComposerBarHost, ComposerBarNotices } from "./ComposerBar.tsx";
import { draftKey, heldDraft } from "./drafts.ts";
import { makeThreadRouter } from "./routes.tsx";
import { threadViewHost } from "./host.ts";
import { closeThreadPanel } from "./rightPanel.ts";

/** What a pane shows, in its environment: a thread, or a project's draft until the server creates its thread. */
type ViewTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string };

/** Whether the server thread the view went to is the one the project's draft created, on the draft's environment or another. */
export function isPromotion(
  draft: Extract<ViewTarget, { kind: "draft" }>,
  environmentId: string,
  threadId: string,
): boolean {
  const draftId = localStorage.getItem(
    draftKey(draft.environmentId, draft.projectId),
  ) as DraftId | null;
  if (draftId === null) return false;
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  const redirect = store.getPromotedDraftRedirect(draftId);
  return (
    // Finalized, the draft is gone from the store but for the redirect its route follows.
    (redirect?.environmentId === environmentId && redirect.threadId === threadId) ||
    session?.threadId === threadId ||
    session?.promotedTo?.threadId === threadId ||
    store.getDraftIdByRef(
      scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
    ) === draftId
  );
}

/** Where `target` is in the view's routes; a draft without a draft yet is the landing, which starts one. */
function targetPath(target: ViewTarget): string {
  // Encoded: the router decodes path parameters, and an id may itself hold an escape (`command%3Amcp…`).
  if (target.kind === "thread") {
    return `/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;
  }
  const draftId = heldDraft(target.environmentId, target.projectId);
  return draftId === null ? "/" : `/draft/${encodeURIComponent(draftId)}`;
}

/**
 * One mounted view and its target, which a draft's promotion turns into the
 * thread it created, live for the components that render by it.
 */
function makeMount(
  initial: ViewTarget,
  onPromoted: (environmentId: string, threadId: string) => void,
) {
  let target = initial;
  const listeners = new Set<() => void>();
  if (target.kind === "thread") closeThreadPanel(target.environmentId, target.threadId);
  return {
    target: () => target,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    home: () => targetPath(target),
    /** The draft became `threadId` on `environmentId`'s server: the view is that thread's from now on. */
    promote(environmentId: string, threadId: string) {
      if (target.kind !== "draft") return;
      localStorage.removeItem(draftKey(target.environmentId, target.projectId));
      target = { kind: "thread", environmentId, threadId };
      closeThreadPanel(environmentId, threadId);
      for (const listener of listeners) listener();
      onPromoted(environmentId, threadId);
    },
  };
}

type Mount = ReturnType<typeof makeMount>;

/**
 * Keeps the pane on its target. A draft follows itself into the thread it
 * creates. Any other thread the view went to opens in the shell, and so does
 * a draft of another project, or any draft reached from a thread (upstream's
 * New thread on branch, send and new), remembered as its project's draft
 * first so the shell's draft takes it up.
 */
function followNavigation(router: AnyRouter, mount: Mount) {
  const target = mount.target();
  const shown = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const goHome = () => void router.navigate({ to: mount.home(), replace: true });
  if (shown?.kind === "server") {
    const { environmentId, threadId } = shown.threadRef;
    if (
      target.kind === "thread" &&
      threadId === target.threadId &&
      environmentId === target.environmentId
    )
      return;
    if (target.kind === "draft" && isPromotion(target, environmentId, threadId)) {
      mount.promote(environmentId, threadId);
      return;
    }
    threadViewHost().openThread(environmentId, threadId);
    goHome();
    return;
  }
  if (shown?.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(shown.draftId);
    if (session !== null) {
      // The pane's own draft, though its composer may have moved it to another environment's project.
      const own =
        target.kind === "draft" &&
        (localStorage.getItem(draftKey(target.environmentId, target.projectId)) === shown.draftId ||
          (session.projectId === target.projectId &&
            session.environmentId === target.environmentId));
      if (own) {
        localStorage.setItem(draftKey(target.environmentId, target.projectId), shown.draftId);
        // The draft's details panel stays closed too, keyed by the thread id the draft holds.
        closeThreadPanel(session.environmentId, session.threadId);
        return;
      }
      localStorage.setItem(draftKey(session.environmentId, session.projectId), shown.draftId);
      threadViewHost().openDraft(session.environmentId, session.projectId);
    }
    goHome();
    return;
  }
  if (router.state.location.pathname === mount.home()) return;
  toastManager.add({
    type: "info",
    title: "Not in Pult yet",
    description: "This page is part of T3 Code's own app.",
  });
  goHome();
}

/**
 * Reports the activity the mounted thread's projection knows to the shell:
 * each subagent of its roster that has a thread, and the thread itself when
 * it is a provider's native subagent, whose work is a runless turn the
 * thread list cannot see; each with when its work started. Live, on the
 * subscription the view holds anyway.
 */
function ActivityReporter({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const projection =
    useThreadProjection(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)))
      ?.projection ?? null;
  useEffect(() => {
    if (projection === null) return;
    const activity = projection.subagents.flatMap((subagent) =>
      subagent.childThreadId === null
        ? []
        : [
            {
              threadId: subagent.childThreadId,
              working: isOrchestrationV2WorkActive(subagent.status),
              workingSince:
                subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
            },
          ],
    );
    const own = deriveProviderSubagentStatus(projection);
    if (own !== null) {
      activity.push({
        threadId: ThreadId.make(threadId),
        working: isOrchestrationV2WorkActive(own.status),
        workingSince: own.startedAt,
      });
    }
    threadViewHost().reportActivity(activity);
  }, [projection, threadId]);
  return null;
}

function useTarget(mount: Mount): ViewTarget {
  return useSyncExternalStore(mount.subscribe, mount.target);
}

function makeRoot(mount: Mount, composerOnly: boolean, header: MountOptions["timelineHeader"]) {
  function NavigationFollower() {
    const router = useRouter();
    useEffect(
      () => router.subscribe("onResolved", () => followNavigation(router, mount)),
      [router],
    );
    return null;
  }
  return function Root() {
    const target = useTarget(mount);
    // A composer-only mount leaves the page-wide shortcuts and the activity to the pane's view, as upstream's background thread does.
    return (
      <BackgroundThreadContext value={composerOnly}>
        <ToastProvider>
          <AnchoredToastProvider>
            <NavigationFollower />
            {target.kind !== "thread" || composerOnly ? null : (
              <ActivityReporter environmentId={target.environmentId} threadId={target.threadId} />
            )}
            <ConfirmDialogHost />
            <CustomSnoozeDialogHost />
            <SidebarProvider defaultOpen={false}>
              <Outlet />
            </SidebarProvider>
            {/* Into the element the timeline's header places, which keeps it across the list's own remounts. */}
            {header === undefined ? null : createPortal(header.content, header.element)}
          </AnchoredToastProvider>
        </ToastProvider>
      </BackgroundThreadContext>
    );
  };
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {children}
    </main>
  );
}

/** A draft without a draft yet starts one in its project, the way upstream's New Thread does. */
function DraftStart({
  environmentId,
  projectId,
}: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const project = useProjects().find(
    (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
  );
  const handleNewThread = useNewThreadHandler();
  const started = useRef(false);
  useEffect(() => {
    if (project === undefined || started.current) return;
    started.current = true;
    void handleNewThread(
      scopeProjectRef(EnvironmentId.make(environmentId), ProjectId.make(projectId)),
      { replace: true },
    );
  }, [environmentId, handleNewThread, project, projectId]);
  return <Notice>{project === undefined ? "Loading the project…" : "Starting a thread…"}</Notice>;
}

function makeLanding(mount: Mount) {
  return function Landing() {
    const target = useTarget(mount);
    return target.kind === "draft" ? (
      <DraftStart environmentId={target.environmentId} projectId={target.projectId} />
    ) : (
      <Notice>This thread is not available. It may have been deleted.</Notice>
    );
  };
}

/** A mounted view, and its composer bar, which the shell may add entries of its own to. */
export interface MountedView {
  dispose(): void;
  readonly bar: HTMLElement;
  /**
   * The draft the view shows became `threadId` on `environmentId`'s server,
   * as the shell learned before the view went there itself: the view goes
   * to the thread now, as upstream's promotion goes, its composer kept, and
   * names it to `onPromoted`. Nothing for a view on a thread already.
   */
  follow(environmentId: string, threadId: string): void;
}

/**
 * What the shell adds to a pane's view, or changes of it: an element of its
 * own at the timeline's top, inside its scroller, and what the view renders
 * into it, inside the view's own providers and router, so upstream's
 * components work there (a Star's fold, which renders its transcripts with
 * upstream's markdown); a draft resting with its composer where a thread's
 * sits, without upstream's hero (`draftHero: false`); and the composer's
 * placeholder, live, in place of upstream's (a Star's, which names it).
 */
export interface MountOptions {
  readonly timelineHeader?: { readonly element: HTMLElement; readonly content: ReactNode };
  readonly draftHero?: boolean;
  readonly placeholder?: ShellValue<string>;
}

/** What the composer renders into the bar in place of what it shows above itself, and the bar's host under its message. */
const composerBarEntries: ComposerControlsSlotEntries = {
  Notices: ComposerBarNotices,
  Host: ComposerBarHost,
};

/**
 * Mounts the view above the pane's composer bar: the thread's settings
 * (model, reasoning, mode, attachments, the context window, a draft's
 * environment and branch) and its notices render there, out
 * of the composer, which keeps the message and its send button
 * (`ComposerControlsSlot`).
 */
function mountView(
  element: HTMLElement,
  target: ViewTarget,
  onPromoted: (environmentId: string, threadId: string) => void,
  composerOnly = false,
  options: MountOptions = {},
): MountedView {
  const mount = makeMount(target, onPromoted);
  const router = makeThreadRouter({
    root: makeRoot(mount, composerOnly, options.timelineHeader),
    landing: makeLanding(mount),
    initialPath: mount.home(),
  });
  element.classList.add("pult-thread-view");
  element.classList.toggle("pult-composer-only", composerOnly);
  const main = document.createElement("div");
  main.className = "pult-thread-main";
  const bar = document.createElement("div");
  bar.className = "pult-composer-bar";
  element.append(main, bar);
  const root = createRoot(main);
  const composerOptions = {
    draftHero: options.draftHero ?? true,
    placeholder: options.placeholder ?? null,
  };
  root.render(
    <StrictMode>
      <AppAtomRegistryProvider>
        <ComposerControlsSlot value={bar}>
          <ComposerControlsSlotEntries value={composerBarEntries}>
            <ShellComposerOptions value={composerOptions}>
              <TimelineHeaderSlot value={options.timelineHeader?.element ?? null}>
                <RouterProvider router={router} />
              </TimelineHeaderSlot>
            </ShellComposerOptions>
          </ComposerControlsSlotEntries>
        </ComposerControlsSlot>
      </AppAtomRegistryProvider>
    </StrictMode>,
  );
  const navigable: AnyRouter = router;
  return {
    bar,
    follow: (environmentId, threadId) => {
      if (mount.target().kind !== "draft") return;
      mount.promote(environmentId, threadId);
      void navigable.navigate({ to: mount.home(), replace: true });
    },
    dispose: () => {
      root.unmount();
      main.remove();
      bar.remove();
    },
  };
}

/** Renders the thread's turns and composer, on its environment, into `element` until disposed. */
export function mountThreadView(
  element: HTMLElement,
  environmentId: string,
  threadId: string,
  options: MountOptions = {},
): MountedView {
  return mountView(element, { kind: "thread", environmentId, threadId }, () => {}, false, options);
}

/**
 * Renders the project's draft, upstream's composer for a new thread, into
 * `element` until disposed: the draft remembered for the project while the
 * composer store holds it, else a new one. When the server creates its
 * thread, the view stays mounted as that thread's, and `onPromoted` names it
 * with the environment it was created on.
 */
export function mountDraftView(
  element: HTMLElement,
  environmentId: string,
  projectId: string,
  onPromoted: (environmentId: string, threadId: string) => void,
  options: MountOptions = {},
): MountedView {
  return mountView(
    element,
    { kind: "draft", environmentId, projectId },
    onPromoted,
    false,
    options,
  );
}

/**
 * The composer alone of a thread or a project's draft, the same draft the
 * pane's view shows, for the strip under a file (`src/composer/`): the view
 * mounted again with its turns hidden (`shell.css`), leaving the page-wide
 * shortcuts and paste to the pane's. A draft's promotion is the pane's to
 * tell the shell.
 */
export function mountComposerView(
  element: HTMLElement,
  target: ViewTarget,
  options: MountOptions = {},
): MountedView {
  return mountView(element, target, () => {}, true, options);
}

export type { ViewTarget };
