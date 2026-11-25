// Stands in for `apps/web`'s `src/components/chat/ThreadDetailsCard.tsx` (`./stubs.ts`), the
// frame of upstream's thread details: the shell's details cards (`src/details/`) float where
// upstream's inline card would, over the chat's top-right corner, from the pane's view alone and
// while that view is the active editor's. Files host the same rows through a portal from the composer strip. A thread's or a draft's details are upstream's rows
// (`ThreadDetailsPanel.tsx`, with its own "Choose what to show" and defaults) in one card of
// upstream's look; a Star's are the shell's cards, which it renders into an element of ours. The
// canvas clears its lane of them as of upstream's card. In a narrow pane the Star shelves
// overlay the lane so its settings stay reachable. The fork's web app keeps upstream's card.
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

import { createPortal } from "react-dom";

import { useChatCanvas } from "~/components/chat/ChatCanvasContext";
import type * as Upstream from "~/components/chat/ThreadDetailsCard";
import type { PopoverCreateHandle } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { type DraftId, type DraftSessionState, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { DetailsModelPickers } from "./DetailsModelPicker.tsx";
import { detailsCardWidth } from "./detailsCardWidth.ts";
import { draftKey, isDraftOf } from "./drafts.ts";
import { type DetailsCards, type DetailsCardsTarget, threadViewHost } from "./host.ts";
import { setThreadPanelInline } from "./rightPanel.ts";
import type { ViewTarget } from "./ThreadView.tsx";

/** The file's composer can portal its thread rows into the workbench beside the file. */
export const DetailsInFile = createContext(false);

export const DetailsTarget = createContext<ViewTarget | null>(null);

/** Upstream's frame's props, which the stub owns. */
interface ThreadDetailsCardProps {
  threadRef: ScopedThreadRef;
  /** Upstream's narrow-pane popover anchor and handle. */
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

/** Whether the view shows this thread or draft, including the channel tag that identifies a draft within a project. */
function isTarget(target: ViewTarget, shown: DetailsCardsTarget): boolean {
  if (shown.kind === "thread")
    return (
      target.kind === "thread" &&
      target.environmentId === shown.environmentId &&
      target.threadId === shown.threadId
    );
  return (
    target.kind === "draft" &&
    JSON.stringify(target.tags) === JSON.stringify(shown.tags) &&
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
      localStorage.getItem(draftKey(target.environmentId, target.projectId, target.tags)) ===
        draft.id)
  );
}

/** The cards' left edge, an invisible handle dragging the panel's width, the same for every view. */
function DetailsCardResizer({
  width,
  right,
}: {
  readonly width: number;
  /** From the canvas's right edge, centred on the panel's left edge. */
  readonly right: number;
}) {
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
      style={{ right }}
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

/** The element the shell renders the right panel's tray into, on the composer buttons' row, as wide as the panel. */
function DetailsTrayHost({ width }: { readonly width: number | string }) {
  const { detailsCards } = threadViewHost();
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    return detailsCards.renderTray(element);
  }, [element, detailsCards]);
  return (
    <div ref={setElement} className="pult-details-island pult-details-tray" style={{ width }} />
  );
}

export function ThreadDetailsCard({ threadRef, onContextMenu, children }: ThreadDetailsCardProps) {
  const target = use(DetailsTarget);
  const inFile = use(DetailsInFile);
  const { detailsCards } = threadViewHost();
  const cards = useSyncExternalStore(detailsCards.subscribe, detailsCards.get);
  const canvas = useChatCanvas();
  const draftId = useComposerDraftStore((state) => state.getDraftIdByRef(threadRef));
  const session = useComposerDraftStore((state) =>
    draftId === null ? null : state.getDraftSession(draftId),
  );
  const draft = draftId === null || session === null ? null : { id: draftId, session };
  const shown =
    target !== null &&
    cards !== null &&
    inFile === (cards.fileRows !== undefined) &&
    showsCards(target, threadRef, draft, cards)
      ? cards
      : null;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const open = shown !== null && !inFile;
  // The canvas reads the card as open from the panel store, whose own toggles do nothing in the
  // shell (`rightPanel.ts`), so the pane's view writes it as the cards show; the composer strip's,
  // of the same thread, leaves it to the pane's.
  useLayoutEffect(() => {
    if (!inFile && target !== null && inlineOpen !== open) setThreadPanelInline(threadRef, open);
  }, [inFile, target, inlineOpen, open, threadRef]);
  const [island, setIsland] = useState<HTMLElement | null>(null);
  const star = shown?.subject.kind === "star";
  const measureDetailsCard = canvas?.measureDetailsCard;
  const width = canvas?.preferredDetailsCard?.width;
  const { environmentId, threadId } = threadRef;
  // The panel occupies its column even when all of its shelves are in the tray.
  const height = canvas?.preferredDetailsCard?.height;
  useLayoutEffect(() => {
    if (!open || width === undefined || height === undefined) return;
    measureDetailsCard?.({
      threadRef: { environmentId, threadId },
      width,
      fullContentHeight: height,
    });
  }, [open, width, height, measureDetailsCard, environmentId, threadId]);
  useLayoutEffect(() => {
    if (island === null || !star) return;
    return detailsCards.renderStar(island);
  }, [island, star, detailsCards]);
  const rows =
    shown === null || star ? null : (
      <div
        className="dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden"
        onContextMenu={onContextMenu}
        data-thread-details-card
      >
        <ScrollArea scrollFade className="min-h-0">
          {children("full")}
        </ScrollArea>
      </div>
    );
  if (shown?.fileRows !== undefined) return rows && createPortal(rows, shown.fileRows);
  const placement = canvas?.detailsCardPlacement ?? null;
  if (shown === null || (placement === null && (!star || canvas === null))) return null;
  const overlay = placement === null;
  const panelWidth = placement?.width ?? `min(calc(100% - 24px), ${detailsCardWidth.get()}px)`;
  const panelHeight =
    placement === null ? undefined : `calc(${placement.height}px - var(--pult-bar-height))`;
  return (
    <>
      <aside
        className="absolute z-22 flex flex-col"
        style={{
          right: placement?.right ?? 12,
          top: placement?.y ?? 12,
          width: panelWidth,
          bottom: overlay ? "var(--pult-bar-height)" : undefined,
          maxHeight: panelHeight,
          height: star ? panelHeight : undefined,
        }}
        data-thread-details-panel={overlay ? "overlay" : "inline"}
      >
        <div className={star ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-col"}>
          {star ? (
            // The shell's own: the view's stylesheet stops at it (`vite.config.ts`).
            <div ref={setIsland} className="pult-details-island pult-details-panel" />
          ) : (
            // Through React's tree, so the rows keep the view's providers, and their right-click is the chooser.
            rows
          )}
        </div>
      </aside>
      {placement === null ? null : (
        <DetailsCardResizer width={placement.width} right={placement.right + placement.width - 3} />
      )}
      <DetailsTrayHost width={panelWidth} />
      {/* A Star's cards' model pickers, drawn from the view's tree into the shell's elements. */}
      {star ? <DetailsModelPickers /> : null}
    </>
  );
}
