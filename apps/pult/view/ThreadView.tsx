// The app around upstream's thread view in Pult's shell: one thread, or one
// project's draft, per pane, on the shell's connection. A draft follows itself
// into the thread it creates; a navigation to another thread or a new one
// opens it in the shell. The view outlives its panes: one React root and one
// router for the panes and one for the composer strip, moved into whichever
// element mounts it and sent to that element's target, as upstream's app
// goes from thread to thread in one ChatView.
import {
  type AnyRouter,
  Outlet,
  RouterProvider,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import {
  type AssistantCitation,
  EnvironmentId,
  isOrchestrationV2WorkActive,
  type MessageHeader,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime, Option, Schema } from "effect";
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
import {
  ShellComposerOptions,
  type ShellReply,
  type ShellValue,
} from "~/components/chat/ShellComposerOptions";
import { ShellDetailsCardWidth } from "~/components/chat/ShellDetailsCardWidth";
import { FileLinkGateContext } from "~/components/chat/fileLinkGate";
import { TimelineHeaderSlot } from "~/components/chat/TimelineHeaderSlot";
import { ShellMessagePresentation } from "~/components/chat/ShellMessagePresentation";
import { SidebarProvider } from "~/components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { isRichTextBoldShortcut } from "~/keybindings";
import { assistantCitationFromLocation } from "~/lib/assistantCitationNavigation";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import { I18nProvider } from "~/i18n/I18nProvider";
import type { RevealOutcome } from "./passageReveal.ts";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useProjects, useThreadProjection } from "~/state/entities";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { ComposerBarHost, ComposerBarNotices } from "./ComposerBar.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { captionLabel, MessageCaption } from "./MessageCaption.tsx";
import {
  draftKey,
  heldDraft,
  isDraftOf,
  isPromotion,
  isTaggedDraft,
  startTaggedDraft,
} from "./drafts.ts";
import { makeThreadRouter, RESTING_PATH } from "./routes.tsx";
import { detailsCardWidth } from "./detailsCardWidth.ts";
import { FileLinkGate } from "./fileLinkGate.tsx";
import { DetailsInFile, DetailsTarget } from "./ThreadDetailsPanel.tsx";
import { threadViewHost } from "./host.ts";

/**
 * What a pane shows, in its environment: a thread, or a project's draft until
 * the server creates its thread; with `tags`, the project's draft whose
 * thread is created with them, apart from its own (`draftKey`).
 */
type ViewTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | {
      readonly kind: "draft";
      readonly environmentId: string;
      readonly projectId: string;
      readonly tags?: ReadonlyArray<string>;
    };

/** What a view shows: its mount's target, or nothing while no element mounts it. */
type Shown = ViewTarget | { readonly kind: "none" };

const NOTHING: Shown = { kind: "none" };

/** Where `target` is in the view's routes; a draft without a draft yet is the landing, which starts one. */
function targetPath(target: Shown): string {
  if (target.kind === "none") return RESTING_PATH;
  // Encoded: the router decodes path parameters, and an id may itself hold an escape (`command%3Amcp…`).
  if (target.kind === "thread") {
    return `/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;
  }
  const draftId = heldDraft(target.environmentId, target.projectId, target.tags);
  return draftId === null ? "/" : `/draft/${encodeURIComponent(draftId)}`;
}

/** Whether `shown` is `target`: two projects' drafts not started yet share one path. */
function isShown(shown: Shown, target: ViewTarget): boolean {
  if (shown.kind === "thread")
    return (
      target.kind === "thread" &&
      shown.environmentId === target.environmentId &&
      shown.threadId === target.threadId
    );
  if (shown.kind === "draft")
    return (
      target.kind === "draft" &&
      draftKey(shown.environmentId, shown.projectId, shown.tags) ===
        draftKey(target.environmentId, target.projectId, target.tags)
    );
  return false;
}

/** How long a navigation a mount started may take before the view follows the router again, whatever it resolves. */
const HEADING_MS = 2000;

/**
 * A view's target and what its mount adds to it, live for the components
 * that render by them: a mount shows a target, a draft's promotion turns
 * it into the thread it created.
 */
function makeMount() {
  let target = NOTHING;
  let onPromoted = (_environmentId: string, _threadId: string) => {};
  let additions = NO_ADDITIONS;
  let consumesCitation: MountOptions["consumesCitation"];
  let draftSent: MountOptions["draftSent"];
  let headingSince: number | undefined;
  let again = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    target: () => target,
    additions: () => additions,
    consumesCitation: () => consumesCitation,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    home: () => targetPath(target),
    /** The view is `next`'s from now on, with what its mount adds; the caller sends the router there. */
    show(
      next: Shown,
      promoted: (environmentId: string, threadId: string) => void,
      options: MountOptions,
    ) {
      target = next;
      onPromoted = promoted;
      consumesCitation = options.consumesCitation;
      draftSent = options.draftSent;
      // A tagged draft rests without the hero, whose project picker would move it to another project's draft.
      const draftHero =
        next.kind === "draft" && next.tags !== undefined ? false : (options.draftHero ?? true);
      const placeholder = options.placeholder ?? null;
      const creationTags = next.kind === "draft" ? (next.tags ?? null) : null;
      const creationHeader = next.kind === "draft" ? (options.creationHeader ?? null) : null;
      const reply = options.reply ?? null;
      const send = options.send ?? null;
      // The same object for the same additions: a new one renders every reader of them again.
      if (
        additions.header !== options.timelineHeader ||
        additions.draftModel !== options.draftModel ||
        additions.composer.draftHero !== draftHero ||
        additions.composer.placeholder !== placeholder ||
        JSON.stringify(additions.composer.creationTags) !== JSON.stringify(creationTags) ||
        additions.composer.creationHeader !== creationHeader ||
        additions.composer.reply !== reply ||
        additions.composer.send !== send
      )
        additions = {
          header: options.timelineHeader,
          draftModel: options.draftModel,
          composer: { draftHero, placeholder, creationTags, creationHeader, reply, send },
        };
      changed();
    },
    /** The router is on its way to the target: what it resolves before it arrives is the previous target's. */
    head() {
      headingSince = performance.now();
    },
    heading: () => headingSince !== undefined && performance.now() - headingSince < HEADING_MS,
    arrive() {
      headingSince = undefined;
    },
    /** How many times the view was shown its own target again, each of which mounts the route's content anew. */
    again: () => again,
    /** The target it shows, in a new element: its content mounts again there, as upstream's mount restores it. */
    remount() {
      again += 1;
      changed();
    },
    /** The draft became `threadId` on `environmentId`'s server: the view is that thread's from now on. */
    promote(environmentId: string, threadId: string) {
      if (target.kind !== "draft") return;
      localStorage.removeItem(draftKey(target.environmentId, target.projectId, target.tags));
      target = { kind: "thread", environmentId, threadId };
      changed();
      onPromoted(environmentId, threadId);
      draftSent?.(environmentId, threadId);
    },
  };
}

type Mount = ReturnType<typeof makeMount>;

/**
 * Keeps the pane on its target. A draft follows itself into the thread it
 * creates. Any other thread the view went to opens in the shell, and so does
 * a draft of another project, or any draft reached from a thread (upstream's
 * New thread on branch, send and new), remembered as its project's draft
 * first so the shell's draft takes it up. While the router heads for a
 * target a mount just showed, what it resolves on the way is the previous
 * target's, or a late navigation of its content (a draft's new-thread
 * handler), and opens nothing in the shell: the router goes on to the
 * target; `arrived` is told once it is there.
 */
function followNavigation(router: AnyRouter, mount: Mount, arrived: () => void) {
  const target = mount.target();
  const shown = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const goHome = () => void router.navigate({ to: mount.home(), replace: true });
  const arrive = () => {
    mount.arrive();
    arrived();
  };
  if (shown?.kind === "server") {
    const { environmentId, threadId } = shown.threadRef;
    if (
      target.kind === "thread" &&
      threadId === target.threadId &&
      environmentId === target.environmentId
    )
      return arrive();
    if (mount.heading()) return goHome();
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
        (localStorage.getItem(draftKey(target.environmentId, target.projectId, target.tags)) ===
          shown.draftId ||
          isDraftOf(target, session));
      if (own) {
        localStorage.setItem(
          draftKey(target.environmentId, target.projectId, target.tags),
          shown.draftId,
        );
        return arrive();
      }
      if (mount.heading()) return goHome();
      if (isTaggedDraft(session))
        throw new Error("todo: a tagged draft reached other than by its own mount.");
      localStorage.setItem(draftKey(session.environmentId, session.projectId), shown.draftId);
      threadViewHost().openDraft(session.environmentId, session.projectId);
    }
    goHome();
    return;
  }
  if (router.state.location.pathname === mount.home()) return arrive();
  if (mount.heading()) return goHome();
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

const decodeModel = Schema.decodeUnknownOption(ModelSelection);

/**
 * Puts the mount's model on the draft the view shows, its own, in place of
 * the one upstream's new-thread handler gave it from the composer's last
 * pick anywhere, unless a model was picked in the draft itself: on each
 * draft the view goes to, and again when the model changes.
 */
function DraftModel({
  target,
  source,
}: {
  target: Extract<ViewTarget, { kind: "draft" }>;
  source: ShellValue<unknown>;
}) {
  const wanted = useSyncExternalStore(source.subscribe, source.get);
  const draftId = useRouterState({
    select: (state) => {
      const shown = resolveThreadRouteTarget(state.matches.at(-1)?.params ?? {});
      return shown?.kind === "draft" ? shown.draftId : null;
    },
  });
  const key = JSON.stringify(wanted ?? null);
  useEffect(() => {
    if (draftId === null) return;
    const selection = Option.getOrNull(decodeModel(JSON.parse(key)));
    if (selection === null) return;
    const store = useComposerDraftStore.getState();
    const session = store.getDraftSession(draftId);
    if (
      session === null ||
      session.environmentId !== target.environmentId ||
      session.projectId !== target.projectId ||
      hasExplicitComposerModelSelection(store.getComposerDraft(draftId))
    )
      return;
    store.setModelSelection(draftId, selection, { replaceOptions: true });
  }, [draftId, key, target.environmentId, target.projectId]);
  return null;
}

function useTarget(mount: Mount): Shown {
  return useSyncExternalStore(mount.subscribe, mount.target);
}

function makeRoot(mount: Mount, bar: HTMLElement, composerOnly: boolean, arrived: () => void) {
  function NavigationFollower() {
    const router = useRouter();
    useEffect(
      () => router.subscribe("onResolved", () => followNavigation(router, mount, arrived)),
      [router],
    );
    return null;
  }
  return function Root() {
    const target = useTarget(mount);
    const { header, draftModel } = useSyncExternalStore(mount.subscribe, mount.additions);
    const again = useSyncExternalStore(mount.subscribe, mount.again);
    // A composer-only mount leaves the page-wide shortcuts and the activity to the pane's view, as upstream's background thread does.
    return (
      <BackgroundThreadContext value={composerOnly}>
        <ToastProvider>
          <AnchoredToastProvider>
            <NavigationFollower />
            {target.kind !== "draft" || draftModel === undefined ? null : (
              <DraftModel target={target} source={draftModel} />
            )}
            {target.kind !== "thread" || composerOnly ? null : (
              <ActivityReporter environmentId={target.environmentId} threadId={target.threadId} />
            )}
            {target.kind !== "thread" ? null : (
              <ContextMeter
                bar={bar}
                environmentId={target.environmentId}
                threadId={target.threadId}
              />
            )}
            <ConfirmDialogHost />
            <CustomSnoozeDialogHost />
            {/* Keyed: a view moved to a new element with its target unchanged mounts its content again, since a moved scroller forgets where it stood. */}
            <SidebarProvider key={again} defaultOpen={false}>
              <DetailsInFile value={composerOnly}>
                <DetailsTarget value={target.kind === "none" ? null : target}>
                  <Outlet />
                </DetailsTarget>
              </DetailsInFile>
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

/** A draft without a draft yet starts one in its project, the way upstream's New Thread does; a tagged one is minted by the shell (`startTaggedDraft`). */
function DraftStart({
  environmentId,
  projectId,
  tags,
}: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly tags: ReadonlyArray<string> | undefined;
}) {
  const project = useProjects().find(
    (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
  );
  const handleNewThread = useNewThreadHandler();
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (project === undefined || started.current) return;
    started.current = true;
    if (tags !== undefined) {
      const draftId = startTaggedDraft(environmentId, projectId, tags);
      void router.navigate({ to: "/draft/$draftId", params: { draftId }, replace: true });
      return;
    }
    void handleNewThread(
      scopeProjectRef(EnvironmentId.make(environmentId), ProjectId.make(projectId)),
      { replace: true },
    );
  }, [environmentId, handleNewThread, project, projectId, router, tags]);
  return <Notice>{project === undefined ? "Loading the project…" : "Starting a thread…"}</Notice>;
}

function makeLanding(mount: Mount) {
  return function Landing() {
    const target = useTarget(mount);
    if (target.kind === "none") return null;
    return target.kind === "draft" ? (
      // Keyed: a view going from one project's draft to another's starts the other's.
      <DraftStart
        key={draftKey(target.environmentId, target.projectId, target.tags)}
        environmentId={target.environmentId}
        projectId={target.projectId}
        tags={target.tags}
      />
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
 * placeholder, live, in place of upstream's (a Star's, which names it);
 * and the model a draft takes, live, in place of the composer's last pick
 * anywhere (a Star's, its last conversation's), as the server's model
 * selection, null for upstream's.
 */
export interface MountOptions {
  readonly timelineHeader?: { readonly element: HTMLElement; readonly content: ReactNode };
  readonly draftHero?: boolean;
  readonly placeholder?: ShellValue<string>;
  readonly draftModel?: ShellValue<unknown>;
  /** The reply the mount's composer writes: where it goes and the replies suggested (an answer to an ask). */
  readonly reply?: ShellReply;
  /** Hands each of the mount's sends to the shell, its draft becoming no thread (a composer an extension handles, `src/extensions/`). */
  readonly send?: ShellComposerOptions["send"];
  /** The header the message that creates a thread from the mount's draft carries, read as it is sent (a Star channel's first message, the line `[To your channel <slug>]`). */
  readonly creationHeader?: ShellValue<MessageHeader>;
  /** Told once the mount's draft has become a thread on the server, its send, whichever mount of the draft sent it. */
  readonly draftSent?: (environmentId: string, threadId: string) => void;
  /**
   * How the mount shows a citation the view would go to, where it keeps one (a Star's earlier
   * conversation, which no route of the view shows); undefined lets the router go. Asked before
   * the router commits the citation's location, the view staying where it is while it answers
   * and, kept, throughout. Its show runs until it ends or the signal aborts, on a newer citation
   * kept or the mount leaving; unshown, the view tells the reader once per activation.
   */
  readonly consumesCitation?: (
    citation: AssistantCitation,
  ) => Promise<((signal: AbortSignal) => Promise<RevealOutcome>) | undefined>;
}

/** What a mount adds to its view, as the view's providers take it. */
interface Additions {
  readonly header: MountOptions["timelineHeader"];
  readonly draftModel: MountOptions["draftModel"];
  readonly composer: ShellComposerOptions;
}

const NO_ADDITIONS: Additions = {
  header: undefined,
  draftModel: undefined,
  composer: {
    draftHero: true,
    placeholder: null,
    creationTags: null,
    creationHeader: null,
    reply: null,
    send: null,
  },
};

/**
 * How the view draws a message's header (`ShellMessagePresentation`): its caption, and a folded
 * message's sender named by the caption's name and note, but a thread's, whose live title
 * upstream's row draws where the view holds it.
 */
const presentMessage = (header: MessageHeader | null, environmentId: string) => {
  const caption = header?.caption ?? null;
  if (header === null || caption === null) return null;
  const label = captionLabel(caption);
  return {
    label: caption.open !== null && "thread" in caption.open ? null : label,
    fallbackLabel: label,
    caption: (
      <MessageCaption
        caption={caption}
        extension={header.extension}
        environmentId={environmentId}
      />
    ),
  };
};

/** What the composer renders into the bar in place of what it shows above itself, and the bar's host under its message. */
const composerBarEntries: ComposerControlsSlotEntries = {
  showAbove: (item) => item.id.startsWith("usage-limit-recovery:"),
  Notices: ComposerBarNotices,
  Host: ComposerBarHost,
};

/** The view's providers around its router, with what the mount showing it adds. */
function ViewProviders({
  mount,
  bar,
  router,
}: {
  readonly mount: Mount;
  readonly bar: HTMLElement;
  readonly router: ReturnType<typeof makeThreadRouter>;
}) {
  const additions = useSyncExternalStore(mount.subscribe, mount.additions);
  return (
    <AppAtomRegistryProvider>
      <ComposerControlsSlot value={bar}>
        <ComposerControlsSlotEntries value={composerBarEntries}>
          <ShellComposerOptions value={additions.composer}>
            <ShellMessagePresentation value={presentMessage}>
              <ShellDetailsCardWidth value={detailsCardWidth}>
                <FileLinkGateContext value={FileLinkGate}>
                  <TimelineHeaderSlot value={additions.header?.element ?? null}>
                    <RouterProvider router={router} />
                  </TimelineHeaderSlot>
                </FileLinkGateContext>
              </ShellDetailsCardWidth>
            </ShellMessagePresentation>
          </ShellComposerOptions>
        </ComposerControlsSlotEntries>
      </ComposerControlsSlot>
    </AppAtomRegistryProvider>
  );
}

/** How long a view no element mounts keeps its thread rendered, for the next mount to take it on from there: a switch's next pane mounts within it. */
const REST_AFTER_MS = 500;
/** How long a view sent from one target to another stays unpainted at most, waiting for the router to arrive. */
const REVEAL_AFTER_MS = 400;

/**
 * A view: upstream's app in a React root and a router of its own, kept for
 * the page's life, since a router's listeners on the document never leave
 * and a new root mounts everything under it again. Its elements go into
 * whichever element mounts it, and out again when that mount is disposed;
 * the view then keeps its thread rendered a moment and, taken by no other
 * mount, rests on an empty route, its ChatView unmounted, so nothing of a
 * thread runs unseen.
 */
function makeView(composerOnly: boolean) {
  const mount = makeMount();
  const bar = document.createElement("div");
  bar.className = "pult-composer-bar";
  const main = document.createElement("div");
  main.className = "pult-thread-main";
  let revealing: ReturnType<typeof setTimeout> | undefined;
  const conceal = (concealed: boolean) => {
    clearTimeout(revealing);
    main.style.opacity = bar.style.opacity = concealed ? "0" : "";
    if (concealed) revealing = setTimeout(() => conceal(false), REVEAL_AFTER_MS);
  };
  const root = createRoot(main);
  /** The reader's input that takes the view over from a citation being asked about. */
  const TAKE_OVER = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
  const LISTENING = { capture: true, passive: true } as const;
  let navigable: AnyRouter | undefined;
  let unblock: (() => void) | undefined;
  /** The latest navigation the router asked about, so a citation's answer arriving after another moves nothing. */
  let asking: object | undefined;
  /** The activation last kept, so a repeated push or replace of it shows nothing more. */
  let kept: string | undefined;
  /** The kept citation being shown, given up for the next one or as the mount leaves. */
  let showing: AbortController | undefined;
  const keepCitation = async ({
    nextLocation,
  }: {
    nextLocation: { href: string; state: { assistantCitationActivation?: string } };
  }) => {
    // Any navigation supersedes a citation still being asked about.
    const asked = {};
    asking = asked;
    const consumes = mount.consumesCitation();
    const citation = consumes && assistantCitationFromLocation(nextLocation.href);
    if (!consumes || !citation) return false;
    const activation = nextLocation.state.assistantCitationActivation ?? nextLocation.href;
    if (kept === activation) return true;
    // A citation gives up the one being shown at once, and the reader taking the view over while
    // it is asked about gives it up too, so a late answer moves nothing.
    showing?.abort();
    const shows = new AbortController();
    showing = shows;
    const takeOver = () => shows.abort();
    for (const event of TAKE_OVER) main.addEventListener(event, takeOver, LISTENING);
    let show: Awaited<ReturnType<typeof consumes>>;
    try {
      show = await consumes(citation);
    } finally {
      for (const event of TAKE_OVER) main.removeEventListener(event, takeOver, LISTENING);
    }
    // A newer citation, or another mount, took over meanwhile: this one goes nowhere.
    if (asking !== asked || mount.consumesCitation() !== consumes) return true;
    if (show === undefined) return false;
    if (shows.signal.aborted) return true;
    kept = activation;
    void show(shows.signal).then((outcome) => {
      if (outcome === "unshown" && !shows.signal.aborted)
        toastManager.add({ type: "info", title: "This earlier passage can't be shown" });
    });
    return true;
  };
  /** The router asks the mount about a citation only while the mount would keep one. */
  const blockCitations = () => {
    const wanted = navigable !== undefined && mount.consumesCitation() !== undefined;
    if (wanted && unblock === undefined)
      unblock = navigable?.history.block({ blockerFn: keepCitation, enableBeforeUnload: false });
    if (!wanted && unblock !== undefined) {
      unblock();
      unblock = undefined;
    }
  };
  let resting: ReturnType<typeof setTimeout> | undefined;
  /** To the mount's target: the router starts there, and goes there from then on. */
  const go = () => {
    if (navigable !== undefined) {
      mount.head();
      return void navigable.navigate({ to: mount.home(), replace: true });
    }
    const router = makeThreadRouter({
      root: makeRoot(mount, bar, composerOnly, () => conceal(false)),
      landing: makeLanding(mount),
      initialPath: mount.home(),
    });
    navigable = router;
    root.render(
      <StrictMode>
        <I18nProvider>
          <ViewProviders mount={mount} bar={bar} router={router} />
        </I18nProvider>
      </StrictMode>,
    );
  };
  return {
    bar,
    /** Into `element`, showing `target`: mounted again, for the target it still shows, else on its way there, unpainted until it arrives. */
    enter(
      element: HTMLElement,
      target: ViewTarget,
      onPromoted: (environmentId: string, threadId: string) => void,
      options: MountOptions,
    ) {
      clearTimeout(resting);
      const before = mount.target();
      const from = mount.home();
      mount.show(target, onPromoted, options);
      const stays = isShown(before, target) && mount.home() === from;
      const rested = before.kind === "none";
      if (!stays && !rested) conceal(true);
      // A bar its composer hosts (`ComposerBarHost`) moves with `main`: taken out, it would stay
      // out while the view goes from thread to thread in one composer, whose host claims it once.
      element.append(main);
      if (!main.contains(bar)) element.append(bar);
      if (stays) mount.remount();
      else go();
      blockCitations();
    },
    /** Out of its element, to rest unless another mount takes it first. */
    leave() {
      main.remove();
      if (!main.contains(bar)) bar.remove();
      // A citation still being asked about goes nowhere once its mount is gone, nor one being shown.
      asking = {};
      showing?.abort();
      resting = setTimeout(() => {
        conceal(false);
        mount.show(NOTHING, () => {}, {});
        go();
        blockCitations();
      }, REST_AFTER_MS);
    },
    follow(environmentId: string, threadId: string) {
      if (mount.target().kind !== "draft") return;
      mount.promote(environmentId, threadId);
      go();
    },
    /** Gone for good: a second view of its kind, once the first is back at rest. */
    discard() {
      clearTimeout(resting);
      clearTimeout(revealing);
      root.unmount();
    },
  };
}

type View = ReturnType<typeof makeView>;

/**
 * A key the view handled stops at its element, as a webview's would: the
 * workbench's keybindings listen bubbling on the window, see every key and
 * count no contenteditable as an input, so Cmd+B in the composer would bold
 * and toggle the sidebar. A key the view leaves goes on to the workbench.
 */
function stopHandledKey(event: KeyboardEvent) {
  if (!event.defaultPrevented || isSaveAsChord(event)) return;
  // The composer swallows Cmd+B with nothing selected, leaving it to the app's sidebar toggle: here the workbench's.
  const bold = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
  if (bold && event.code === "KeyB" && !isRichTextBoldShortcut(event, window.getSelection()))
    return;
  event.stopPropagation();
}

/**
 * Cmd+Shift+S is the workbench's in the composer too (Pult: Settle Thread in a
 * thread tab, else Save As), not its strikethrough's, which `~~text~~` still
 * types: marked handled on its way down, which ProseMirror's editor ignores a
 * handled key for, and let on past `stopHandledKey` to the workbench.
 */
function yieldSaveAsChord(event: KeyboardEvent) {
  if (isSaveAsChord(event)) event.preventDefault();
}

function isSaveAsChord(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === "KeyS"
  );
}

/** The views no element mounts, one per kind at most: the next mount of the kind takes it. */
const atRest: { pane?: View; composer?: View } = {};

/**
 * Mounts the view of its kind, the one at rest or a new one, above the
 * pane's composer bar: the thread's settings
 * (model, reasoning, mode, attachments, a draft's environment and branch)
 * and its notices render there, out of the composer, which keeps the
 * message and its send button (`ComposerControlsSlot`), and so does the
 * shell's context window meter (`ContextMeter.tsx`).
 */
function mountView(
  element: HTMLElement,
  target: ViewTarget,
  onPromoted: (environmentId: string, threadId: string) => void,
  composerOnly = false,
  options: MountOptions = {},
): MountedView {
  const kind = composerOnly ? "composer" : "pane";
  const view = atRest[kind] ?? makeView(composerOnly);
  delete atRest[kind];
  element.classList.add("pult-thread-view");
  element.classList.toggle("pult-composer-only", composerOnly);
  element.addEventListener("keydown", yieldSaveAsChord, true);
  element.addEventListener("keydown", stopHandledKey);
  let scrolling: HTMLElement | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const hideScrollbar = () => {
    scrolling?.removeAttribute("data-pult-scrolling");
    scrolling = undefined;
  };
  const onScroll = (event: Event) => {
    const scroller = event.target;
    if (
      !(scroller instanceof HTMLElement) ||
      !scroller.matches(".messages-timeline-scroll, .messages-timeline-row-frame.overflow-y-auto")
    )
      return;
    if (scrolling !== scroller) {
      hideScrollbar();
      scrolling = scroller;
      scrolling.setAttribute("data-pult-scrolling", "");
    }
    clearTimeout(idle);
    idle = setTimeout(hideScrollbar, 650);
  };
  element.addEventListener("scroll", onScroll, true);
  view.enter(element, target, onPromoted, options);
  let disposed = false;
  return {
    bar: view.bar,
    follow: (environmentId, threadId) => {
      if (!disposed) view.follow(environmentId, threadId);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      element.removeEventListener("keydown", yieldSaveAsChord, true);
      element.removeEventListener("keydown", stopHandledKey);
      element.removeEventListener("scroll", onScroll, true);
      clearTimeout(idle);
      hideScrollbar();
      view.leave();
      if (atRest[kind] === undefined) atRest[kind] = view;
      else view.discard();
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
  target: Extract<ViewTarget, { kind: "draft" }>,
  onPromoted: (environmentId: string, threadId: string) => void,
  options: MountOptions = {},
): MountedView {
  return mountView(element, target, onPromoted, false, options);
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
