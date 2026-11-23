import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
// Keep in sync with --thread-details-panel-width.
export const THREAD_DETAILS_CARD_WIDTH = 280;
// Pult: the narrowest the user can drag the card, and the narrowest a dragged card gives way to.
export const THREAD_DETAILS_CARD_MIN_WIDTH = 240;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  narrowestWidth = container.width,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
  preferredWidth,
}: {
  container: { width: number; height: number };
  // While a panel animates the container, the card fits only if it fits at both ends.
  narrowestWidth?: number;
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
  /** Pult: the width the user dragged the card to (`ShellDetailsCardWidth`); upstream's app sets none. */
  preferredWidth?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  // The transition ends are sampled once, so a resize mid-animation can leave them
  // wider than the container is now.
  const fitWidth = Math.min(narrowestWidth, container.width);
  const room = fitWidth - gap - DETAILS_CARD_CLEARANCE - lane.padding - lane.minChatWidth;
  // Pult: a card of a dragged width gives way to the chat's lane, down to the narrowest it drags to.
  const width =
    preferredWidth === undefined
      ? THREAD_DETAILS_CARD_WIDTH
      : Math.min(preferredWidth, Math.max(room, THREAD_DETAILS_CARD_MIN_WIDTH));
  if (room < width) return null;
  const x = container.width - width - gap;
  const y = gap + topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(container.height - y - gap, frame.y - y - gap)
      : container.height - y - gap;
  if (height < 160) return null;
  return {
    x,
    right: gap,
    width,
    y,
    height,
  } as const;
}
