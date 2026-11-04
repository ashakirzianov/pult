// Pult's hook point, not upstream's: an element the app around the view hands
// the timeline to show at its top, above the turns, inside the timeline's
// scroller, so it scrolls with them. Pult fills it on a Star's tab with the fold
// of its earlier conversations (`apps/pult/src/stars/tab.tsx`).
import { createContext, type CSSProperties, useContext } from "react";

/** The element the timeline shows at its top; null, as upstream's app leaves it, for none. */
export const TimelineHeaderSlot = createContext<HTMLElement | null>(null);

/**
 * The slot's element in the timeline's lane, where the timeline's header
 * renders it; nothing without one. The element is the app's, moved here as
 * the header mounts, its content the app's to render.
 */
export function TimelineHeaderSlotOutlet({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const slot = useContext(TimelineHeaderSlot);
  if (slot === null) return null;
  return (
    <div
      className={
        className ? `messages-timeline-row-frame ${className}` : "messages-timeline-row-frame"
      }
      style={style}
    >
      <div
        className="chat-content-lane"
        ref={(node) => {
          node?.append(slot);
        }}
      />
    </div>
  );
}
