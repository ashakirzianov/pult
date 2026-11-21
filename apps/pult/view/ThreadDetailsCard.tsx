// Stands in for `apps/web`'s `src/components/chat/ThreadDetailsCard.tsx` (`./stubs.ts`), the
// frame of upstream's thread details: its rows (`ThreadDetailsPanel.tsx`, with its own "Choose
// what to show" and defaults) render into the shell's Details column (`src/details/`) instead of
// a card over the chat's top-right corner, from the pane's view alone and only while the
// column's subject is the thread or draft that view shows. The right panel store stays closed
// (`rightPanel.ts`), so the chat's canvas keeps no room for a card. The fork's own web app keeps
// upstream's card.
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type ComponentProps,
  createContext,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  use,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import type * as Upstream from "~/components/chat/ThreadDetailsCard";
import type { PopoverCreateHandle } from "~/components/ui/popover";
import { type DetailsColumn, threadViewHost } from "./host.ts";
import type { ViewTarget } from "./ThreadView.tsx";

/** The target of the pane's view rendering the frame; null in the composer strip's view, which renders no details. */
export const DetailsTarget = createContext<ViewTarget | null>(null);

/** Upstream's frame's props, which the stub owns. */
interface ThreadDetailsCardProps {
  threadRef: ScopedThreadRef;
  /** Upstream's popover's anchor and handle, for its narrow-pane mode; the column uses neither. */
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  /** Upstream measures its densities again when it changes; the column always renders the full one. */
  contentKey: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// A merge that changes upstream's frame's props fails the typecheck here, so the stub is read again.
true satisfies Exactly<ThreadDetailsCardProps, ComponentProps<typeof Upstream.ThreadDetailsCard>>;

/** Whether the column's subject is the view's target, and the frame is the target's own thread's. */
function showsSubject(
  target: ViewTarget,
  threadRef: ScopedThreadRef,
  subject: DetailsColumn["subject"],
): boolean {
  if (subject.kind === "thread")
    return (
      target.kind === "thread" &&
      target.environmentId === subject.environmentId &&
      target.threadId === subject.threadId &&
      threadRef.environmentId === subject.environmentId &&
      threadRef.threadId === subject.threadId
    );
  return (
    target.kind === "draft" &&
    target.tags === undefined &&
    target.environmentId === subject.environmentId &&
    target.projectId === subject.projectId
  );
}

export function ThreadDetailsCard({ threadRef, onContextMenu, children }: ThreadDetailsCardProps) {
  const target = use(DetailsTarget);
  const { detailsColumn } = threadViewHost();
  const column = useSyncExternalStore(detailsColumn.subscribe, detailsColumn.get);
  if (target === null || column === null || !showsSubject(target, threadRef, column.subject))
    return null;
  // Through React's tree, so the rows keep the view's providers, and their right-click is the chooser.
  return createPortal(
    <div className="pult-thread-details" onContextMenu={onContextMenu}>
      {children("full")}
    </div>,
    column.element,
  );
}
