// Stands in for `apps/web`'s `src/components/chat/ThreadDetailsCard.tsx` (`./stubs.ts`), the
// frame of upstream's thread details: the shell's details cards (`src/details/`) float where
// upstream's inline card would, over the chat's top-right corner, from the pane's view alone and
// only while that view is the active editor's. A thread's or a draft's details are upstream's rows
// (`ThreadDetailsPanel.tsx`, with its own "Choose what to show" and defaults) in one card of
// upstream's look; a Star's are the shell's cards, which it renders into an element of ours. The
// canvas clears its lane of them as of upstream's card, and where it has no room for one they do
// not show. The fork's own web app keeps upstream's card.
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type ComponentProps,
  createContext,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useChatCanvas } from "~/components/chat/ChatCanvasContext";
import type * as Upstream from "~/components/chat/ThreadDetailsCard";
import type { PopoverCreateHandle } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { type DraftId, type DraftSessionState, useComposerDraftStore } from "~/composerDraftStore";
import { observeResize } from "~/lib/observeResize";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { detailsCardWidth } from "./detailsCardWidth.ts";
import { draftKey, isDraftOf } from "./drafts.ts";
import { type DetailsCards, type DetailsCardsTarget, threadViewHost } from "./host.ts";
import { setThreadPanelInline } from "./rightPanel.ts";
import type { ViewTarget } from "./ThreadView.tsx";

/** The target of the pane's view rendering the frame; null in the composer strip's view, which renders no details. */
export const DetailsTarget = createContext<ViewTarget | null>(null);

/** Upstream's frame's props, which the stub owns. */
interface ThreadDetailsCardProps {
  threadRef: ScopedThreadRef;
  /** Upstream's popover's anchor and handle, for its narrow-pane mode, which the cards do not have. */
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  /** Upstream measures its densities again when it changes; the card always renders the full one. */
  contentKey: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}

/** Whether A and B are one type: assignability both ways would miss an optional prop added or dropped. */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// A merge that changes upstream's frame's props fails the typecheck here, so the stub is read again.
true satisfies Exactly<ThreadDetailsCardProps, ComponentProps<typeof Upstream.ThreadDetailsCard>>;

/** Whether the view's target is `shown`; a Star's channel's draft (`tags`) is never a view the cards float over. */
function isTarget(target: ViewTarget, shown: DetailsCardsTarget): boolean {
  if (shown.kind === "thread")
    return (
      target.kind === "thread" &&
      target.environmentId === shown.environmentId &&
      target.threadId === shown.threadId
    );
  return (
    target.kind === "draft" &&
    target.tags === undefined &&
    target.environmentId === shown.environmentId &&
    target.projectId === shown.projectId
  );
}

/**
 * Whether the frame is the cards' view's own: the view's target is that
 * view, and for a thread's or a draft's details the frame is the target's
 * own thread's, a draft's its draft session's, since while the view goes to
 * a new target the router still renders the previous one's.
 */
function showsCards(
  target: ViewTarget,
  threadRef: ScopedThreadRef,
  draft: { readonly id: DraftId; readonly session: DraftSessionState } | null,
  cards: DetailsCards,
): boolean {
  if (!isTarget(target, cards.view)) return false;
  const { subject } = cards;
  if (subject.kind === "star") return true;
  if (subject.kind === "thread")
    return (
      isTarget(target, subject) &&
      threadRef.environmentId === subject.environmentId &&
      threadRef.threadId === subject.threadId
    );
  return (
    isTarget(target, subject) &&
    target.kind === "draft" &&
    draft !== null &&
    // The pane's own draft, though its composer may have moved it to another environment's project (`ThreadView.tsx`).
    (isDraftOf(target, draft.session) ||
      localStorage.getItem(draftKey(target.environmentId, target.projectId)) === draft.id)
  );
}

/** The cards' left edge, an invisible handle dragging the panel's width, the same for every view. */
function DetailsCardResizer({ width }: { readonly width: number }) {
  const drag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly width: number;
    /** The last width the panel showed at. */
    readonly fits: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (drag.current !== null) drag.current = { ...drag.current, fits: width };
  }, [width]);
  // A move the canvas has no place for unmounts this handle and its capture: the drag ends at the last width that showed.
  useLayoutEffect(
    () => () => {
      if (drag.current === null) return;
      detailsCardWidth.set(drag.current.fits);
      detailsCardWidth.keep();
    },
    [],
  );
  return (
    <div
      aria-hidden
      className="pult-details-resizer"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current !== null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, fits: width };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        detailsCardWidth.set(current.width + current.x - event.clientX);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        detailsCardWidth.keep();
      }}
    />
  );
}

export function ThreadDetailsCard({ threadRef, onContextMenu, children }: ThreadDetailsCardProps) {
  const target = use(DetailsTarget);
  const { detailsCards } = threadViewHost();
  const cards = useSyncExternalStore(detailsCards.subscribe, detailsCards.get);
  const canvas = useChatCanvas();
  const draftId = useComposerDraftStore((state) => state.getDraftIdByRef(threadRef));
  const session = useComposerDraftStore((state) =>
    draftId === null ? null : state.getDraftSession(draftId),
  );
  const draft = draftId === null || session === null ? null : { id: draftId, session };
  const shown =
    target !== null && cards !== null && showsCards(target, threadRef, draft, cards) ? cards : null;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const open = shown !== null;
  // The canvas reads the card as open from the panel store, whose own toggles do nothing in the
  // shell (`rightPanel.ts`), so the pane's view writes it as the cards show; the composer strip's,
  // of the same thread, leaves it to the pane's.
  useLayoutEffect(() => {
    if (target !== null && inlineOpen !== open) setThreadPanelInline(threadRef, open);
  }, [target, inlineOpen, open, threadRef]);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [island, setIsland] = useState<HTMLElement | null>(null);
  const star = shown?.subject.kind === "star";
  const measured = star ? island : content;
  const measureDetailsCard = canvas?.measureDetailsCard;
  const width = canvas?.preferredDetailsCard?.width;
  const { environmentId, threadId } = threadRef;
  // Only the laid-out cards know their height, which the canvas keeps its lane and preview clear of.
  useLayoutEffect(() => {
    if (measured === null || width === undefined || measureDetailsCard === undefined) return;
    // A thread's card adds its border to its rows'.
    const border = star ? 0 : 2;
    const measure = () =>
      measureDetailsCard({
        threadRef: { environmentId, threadId },
        width,
        fullContentHeight: measured.offsetHeight + border,
      });
    measure();
    return observeResize(measured, measure);
  }, [measured, star, width, measureDetailsCard, environmentId, threadId]);
  useLayoutEffect(() => {
    if (island === null || !star) return;
    return detailsCards.renderStar(island);
  }, [island, star, detailsCards]);
  const placement = canvas?.detailsCardPlacement ?? null;
  // Where the canvas has no room for a card beside its lane, the cards do not show.
  if (shown === null || placement === null) return null;
  return (
    <aside
      className="absolute z-20 flex flex-col"
      style={{
        right: placement.right,
        top: placement.y,
        width: placement.width,
        maxHeight: placement.height,
      }}
      data-thread-details-panel="inline"
    >
      <div className="flex min-h-0 flex-col overflow-y-auto">
        {star ? (
          // The shell's own: the view's stylesheet stops at it (`vite.config.ts`).
          <div ref={setIsland} className="pult-details-island" />
        ) : (
          // Through React's tree, so the rows keep the view's providers, and their right-click is the chooser.
          <div
            className="dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden"
            onContextMenu={onContextMenu}
            data-thread-details-card
          >
            <ScrollArea scrollFade className="min-h-0">
              <div ref={setContent}>{children("full")}</div>
            </ScrollArea>
          </div>
        )}
      </div>
      <DetailsCardResizer width={placement.width} />
    </aside>
  );
}
