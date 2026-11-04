// Loaded with the thread view, from the Star's tab (`tab.tsx`), and rendered
// inside the view's own tree (`MountOptions.timelineHeader`), since the
// transcripts render with upstream's markdown.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { ConversationDivider, TranscriptEntries } from "../../thread-view/shell/StarTranscript.tsx";
import { threadStore } from "../threads/store.ts";
import {
  foldStore,
  foldView,
  readTranscript,
  setFoldOpen,
  showOlder,
  transcriptReading,
} from "./foldState.ts";
import { starById, starStore } from "./model.ts";
import { foldHome, type StarHome } from "./stars.ts";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);

/** "14:32" today, "Nov 2, 14:32" this year, else with the year. */
function clock(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const now = new Date();
  const hours = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    time,
  );
  if (time.toDateString() === now.toDateString()) return hours;
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(time.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(time);
  return `${day}, ${hours}`;
}

/** The nearest element above `element` that scrolls: the timeline's list, or over an empty timeline the slot's own frame. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** LegendList's own tolerance, below which it leaves a change of its header's size alone (`SCROLL_ADJUST_EPSILON`). */
const LIST_ADJUST_EPSILON = 0.1;

/**
 * The timeline list's header, LegendList's element around what the timeline
 * puts at its top, the fold's slot among it (`TimelineHeaderSlotOutlet`, a
 * row frame of the header's own); null over an empty timeline, which has no
 * list.
 */
function listHeaderOf(element: HTMLElement): HTMLElement | null {
  if (element.closest(".messages-timeline-scroll") === null) return null;
  return element.closest(".messages-timeline-row-frame")?.parentElement ?? null;
}

/**
 * Keeps what the user reads where it is as the fold changes height, so a
 * conversation opening, or an older one shown, grows the fold upwards, out
 * of sight. In a timeline's list the anchor is the list's header, the fold
 * and what the timeline shows beside it, and exactly one of the list and
 * the fold moves the scroller by the change: LegendList while the
 * viewport's top was at or past the header's end
 * (`shouldAdjustForHeaderSizeChange`), the fold otherwise. Over an empty
 * timeline, the fold alone, while its bottom was below the viewport's top.
 * Where the viewport's top was is the scroller's offset as its last scroll
 * event left it, before this frame's changes, LegendList's own adjustment's
 * among them. The fold placed into a timeline, as the view mounts or its
 * list mounts its header again, moves nothing.
 */
function useAnchoredHeight() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    // Undefined while the fold is in no timeline.
    let height = element.isConnected ? element.offsetHeight : undefined;
    const initial = scrollerOf(element);
    let settled = initial === null ? undefined : { scroller: initial, top: initial.scrollTop };
    const onScroll = (event: Event) => {
      const scroller = scrollerOf(element);
      if (event.target === scroller && scroller !== null)
        settled = { scroller, top: scroller.scrollTop };
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const observer = new ResizeObserver(() => {
      const previous = height;
      height = element.isConnected ? element.offsetHeight : undefined;
      if (previous === undefined || height === undefined || height === previous) return;
      const change = height - previous;
      const scroller = scrollerOf(element);
      if (scroller === null) return;
      const before = settled?.scroller === scroller ? settled.top : scroller.scrollTop;
      const header = listHeaderOf(element);
      // The anchor's end before the change, in the scroller's content, which no scrolling moves.
      const end =
        (header ?? element).getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        change;
      const listAdjusts = header !== null && before >= end - LIST_ADJUST_EPSILON;
      if (!listAdjusts && before <= end) scroller.scrollTop += change;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [element]);
  return setElement;
}

function Conversation({
  home,
  name,
  environmentName,
}: {
  home: StarHome;
  name: string;
  environmentName: string | undefined;
}) {
  const reading = transcriptReading(home.environmentId, home.root, name);
  if (reading === undefined || reading.status === "loading")
    return <p className="pult-star-fold-note">Reading the conversation…</p>;
  if (reading.status === "failed")
    return (
      <p className="pult-star-fold-note">
        Pult could not read this conversation: {reading.message}
      </p>
    );
  const { transcript, truncated } = reading;
  return (
    <>
      {transcript.partial ? (
        <p className="pult-star-fold-note">
          The start of this conversation is not in its transcript, written from its latest turns
          alone.
        </p>
      ) : null}
      <TranscriptEntries
        entries={transcript.entries}
        environmentId={home.environmentId}
        cwd={home.root}
      />
      {truncated ? (
        <p className="pult-star-fold-note">The rest of this conversation is in its file, {name}.</p>
      ) : null}
      <ConversationDivider
        label={`Fell asleep ${clock(transcript.ended)}`.trim()}
        detail={environmentName}
      />
    </>
  );
}

/**
 * The fold of a Star's earlier conversations, at the top of its timeline
 * (xaxis `pult/issues/star-sleep`): the transcripts of the environment its
 * conversation runs on, or ran on last (`foldHome`), never live threads.
 * Collapsed, "Earlier conversations · N", the folder's listing alone, and
 * nothing at 0; open, its newest transcript right above the live view, each
 * conversation followed by its divider, "Fell asleep 14:32", with the
 * environment's name while the page holds several, and Show more above,
 * the next older one at a time. The fold's state is kept apart from the
 * view, which mounts again as the conversation changes (`foldState.ts`).
 */
export default function StarFold({ starId }: { starId: string }) {
  const star = useSyncExternalStore(starStore.subscribe, () => starById(starId));
  useSyncExternalStore(foldStore.subscribe, foldStore.version);
  const anchor = useAnchoredHeight();
  const home = star === undefined ? undefined : foldHome(star);
  // Named while the page holds several environments.
  const environmentName = useSyncExternalStore(subscribeToThreads, () =>
    home === undefined ? undefined : threadStore.distinguishing(home.environmentId),
  );
  const names = home?.transcripts ?? [];
  const view = foldView(starId);
  // Oldest first, the newest right above the live view.
  const shown = view.open ? names.slice(-view.shown) : [];
  useEffect(() => {
    if (home !== undefined)
      for (const name of shown) readTranscript(home.environmentId, home.root, name);
  });
  if (home === undefined || names.length === 0) return null;
  return (
    <div ref={anchor} className="pult-star-fold" data-open={view.open || undefined}>
      <button
        type="button"
        className="pult-star-fold-toggle"
        aria-expanded={view.open}
        onClick={() => setFoldOpen(starId, !view.open)}
      >
        <span className="pult-star-fold-rule" aria-hidden />
        <span className="pult-star-fold-label">
          <i className={`codicon codicon-chevron-${view.open ? "down" : "right"}`} aria-hidden />
          Earlier conversations · {names.length}
        </span>
        <span className="pult-star-fold-rule" aria-hidden />
      </button>
      {view.open && shown.length < names.length ? (
        <button type="button" className="pult-star-fold-more" onClick={() => showOlder(starId)}>
          Show more
        </button>
      ) : null}
      {shown.map((name) => (
        <Conversation key={name} home={home} name={name} environmentName={environmentName} />
      ))}
    </div>
  );
}
