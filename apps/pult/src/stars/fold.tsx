// Loaded with the thread view, from the Star's tab (`tab.tsx`), and rendered
// inside the view's own tree (`MountOptions.timelineHeader`), since the
// transcripts render with upstream's markdown.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { revealPassage } from "../../view/passageReveal.ts";
import {
  ConversationDivider,
  type RevealTarget,
  TranscriptEntries,
} from "../../view/StarTranscript.tsx";
import { threadStore } from "../threads/store.ts";
import {
  channelTranscriptNames,
  foldStore,
  foldView,
  keepFoldPlace,
  pendingReveal,
  followChannelTranscriptNames,
  readTranscript,
  setFoldOpen,
  showOlder,
  transcriptReading,
} from "./foldState.ts";
import { pluginFeatures } from "./about.ts";
import { CHANNEL_HISTORY_FEATURE } from "./plugin.ts";
import { type ChannelTab, starById, starStore } from "./model.ts";
import { drawnHome, type StarHome } from "./stars.ts";

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
 * among them. The fold placed into a timeline's list, as the view mounts or
 * its list mounts its header again, moves nothing. Placed over an empty
 * timeline, a sleeping Star's draft, it takes the slot's scroller to its
 * end, where the next message goes, unless a citation's reveal is pending,
 * which places the scroller itself; placed again whenever the view puts the
 * slot into another scroller, as a remount of the view's content does in the
 * frame it shows a Star's draft again, which changes no size of the fold's.
 */
function useAnchoredHeight(element: HTMLElement | null, key: string) {
  useLayoutEffect(() => {
    if (element === null) return;
    // Undefined while the fold is in no timeline.
    let height = element.isConnected ? element.offsetHeight : undefined;
    // Watched too, so its leaving the page tells the fold it was moved.
    let placedIn = element.isConnected ? scrollerOf(element) : null;
    let settled = placedIn === null ? undefined : { scroller: placedIn, top: placedIn.scrollTop };
    const place = (scroller: HTMLElement) => {
      if (listHeaderOf(element) !== null || pendingReveal(key) !== undefined) return;
      scroller.scrollTop = scroller.scrollHeight;
      settled = { scroller, top: scroller.scrollTop };
    };
    if (placedIn !== null) place(placedIn);
    const onScroll = (event: Event) => {
      const scroller = scrollerOf(element);
      if (event.target === scroller && scroller !== null)
        settled = { scroller, top: scroller.scrollTop };
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const observer = new ResizeObserver(() => {
      const previous = height;
      height = element.isConnected ? element.offsetHeight : undefined;
      const scroller = element.isConnected ? scrollerOf(element) : null;
      if (scroller !== placedIn) {
        if (placedIn !== null) observer.unobserve(placedIn);
        placedIn = scroller;
        if (scroller !== null) {
          observer.observe(scroller);
          place(scroller);
        }
        return;
      }
      if (previous === undefined || height === undefined || height === previous) return;
      if (scroller === null) return;
      const change = height - previous;
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
    if (placedIn !== null) observer.observe(placedIn);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [element, key]);
}

function Conversation({
  starId,
  home,
  name,
  channel,
  environmentName,
  target,
}: {
  starId: string;
  home: StarHome;
  name: string;
  channel?: string | undefined;
  environmentName: string | undefined;
  target: RevealTarget | undefined;
}) {
  const reading = transcriptReading(home.environmentId, starId, name, channel);
  if (reading === undefined || reading.status === "loading")
    return <p className="pult-star-fold-note">Reading the conversation…</p>;
  if (reading.status === "failed")
    return (
      <p className="pult-star-fold-note">
        Pult could not read this conversation: {reading.message}
      </p>
    );
  const { transcript } = reading;
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
        target={target}
      />
      <ConversationDivider
        label={`Fell asleep ${clock(transcript.ended)}`.trim()}
        detail={environmentName}
      />
    </>
  );
}

/**
 * The fold of a Star's earlier conversations, at the top of its timeline
 * (monore `pult/tasks/star-sleep.task`): the transcripts of the home it is drawn
 * from (`drawnHome`), never live threads, their names from the Pult plugin's
 * `stars` route and each one read from its transcript route (`foldState.ts`).
 * Open until the user collapses it, kept so for the page's session;
 * collapsed, "Earlier conversations · N", the names alone, and
 * nothing at 0; open, its newest transcript right above the live view, each
 * conversation followed by its divider, "Fell asleep 14:32", with the
 * environment's name while the page holds several, and Show more above,
 * the next older one at a time. The fold's state is kept apart from the
 * view, which mounts again as the conversation changes (`foldState.ts`).
 */
export default function StarFold({
  starId,
  channel,
}: {
  starId: string;
  channel?: ChannelTab | undefined;
}) {
  const star = useSyncExternalStore(starStore.subscribe, () => starById(starId));
  useSyncExternalStore(foldStore.subscribe, foldStore.version);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const key = channel ? JSON.stringify([starId, channel.environmentId, channel.slug]) : starId;
  useAnchoredHeight(element, key);
  const home = channel
    ? star?.homes.find((each) => each.environmentId === channel.environmentId)
    : star && drawnHome(star);
  // Named while the page holds several environments.
  const environmentName = useSyncExternalStore(subscribeToThreads, () =>
    home === undefined ? undefined : threadStore.distinguishing(home.environmentId),
  );
  // A channel's tab lists its own transcripts while its fold is mounted (`foldState.ts`); an older
  // plugin's answer carries them all, as `histories`.
  const hasHistory =
    channel !== undefined &&
    pluginFeatures(channel.environmentId)?.has(CHANNEL_HISTORY_FEATURE) === true;
  const listsChannel = hasHistory && home?.histories === undefined;
  const channelEnvironment = channel?.environmentId;
  const channelSlug = channel?.slug;
  useEffect(() => {
    if (channelEnvironment === undefined || channelSlug === undefined || !listsChannel) return;
    return followChannelTranscriptNames(channelEnvironment, starId, channelSlug);
  }, [channelEnvironment, channelSlug, starId, listsChannel]);
  const names = !channel
    ? (home?.conversations ?? [])
    : !hasHistory
      ? []
      : listsChannel
        ? channelTranscriptNames(channel.environmentId, starId, channel.slug)
        : (home?.histories?.find((each) => each.slug === channel.slug)?.names ?? []);
  const view = foldView(key);
  // Oldest first, the newest right above the live view.
  const shown = view.open ? names.slice(-view.shown) : [];
  useEffect(() => {
    if (home !== undefined)
      for (const name of shown) readTranscript(home.environmentId, starId, name, channel?.slug);
  });
  useEffect(() => {
    if (element === null) return;
    // Where the reader is, back once the fold has shrunk back and its anchoring has moved the
    // scroller, unless the reader takes it over meanwhile.
    keepFoldPlace(key, () => {
      const scroller = scrollerOf(element);
      if (scroller === null) return () => {};
      const top = scroller.scrollTop;
      return () => {
        let taken = false;
        const takeOver = () => void (taken = true);
        const events = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
        for (const event of events) scroller.addEventListener(event, takeOver, { passive: true });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const event of events) scroller.removeEventListener(event, takeOver);
            if (!taken) scroller.scrollTop = top;
          }),
        );
      };
    });
    return () => keepFoldPlace(key, undefined);
  }, [element, key]);
  const reveal = pendingReveal(key);
  const body = useRef<HTMLElement | null>(null);
  const target: RevealTarget | undefined =
    reveal === undefined
      ? undefined
      : { messageId: reveal.messageId, body: (each) => void (body.current = each) };
  useEffect(() => {
    if (reveal === undefined || element === null) return;
    const scroller = scrollerOf(element);
    if (scroller === null) return reveal.finish("unshown");
    // The fold leaving the timeline stops this run alone: the view's mount gives the reveal up as it leaves, and a fold mounted again takes it on.
    const gone = new AbortController();
    void revealPassage({
      fold: element,
      scroller,
      body: () => body.current,
      // Every conversation shown read, or failed, so nothing above the passage grows any more.
      ready: () => {
        const now = starById(starId);
        const home = now === undefined ? undefined : drawnHome(now);
        const { open, shown } = foldView(key);
        return (
          home !== undefined &&
          open &&
          home.conversations.slice(-shown).every((name) => {
            const reading = transcriptReading(home.environmentId, starId, name);
            return reading !== undefined && reading.status !== "loading";
          })
        );
      },
      citation: reveal.citation,
      signal: AbortSignal.any([reveal.signal, gone.signal]),
    }).then((outcome) => {
      if (!gone.signal.aborted) reveal.finish(outcome);
    });
    return () => gone.abort();
  }, [reveal, element, starId, key]);
  if (home === undefined || names.length === 0) return null;
  return (
    <div ref={setElement} className="pult-star-fold" data-open={view.open || undefined}>
      <button
        type="button"
        className="pult-star-fold-toggle"
        aria-expanded={view.open}
        onClick={() => setFoldOpen(key, !view.open)}
      >
        <span className="pult-star-fold-rule" aria-hidden />
        <span className="pult-star-fold-label">
          <i className={`codicon codicon-chevron-${view.open ? "down" : "right"}`} aria-hidden />
          Earlier conversations · {names.length}
        </span>
        <span className="pult-star-fold-rule" aria-hidden />
      </button>
      {view.open && shown.length < names.length ? (
        <button type="button" className="pult-star-fold-more" onClick={() => showOlder(key)}>
          Show more
        </button>
      ) : null}
      {shown.map((name) => (
        <Conversation
          key={name}
          starId={starId}
          home={home}
          name={name}
          channel={channel?.slug}
          environmentName={environmentName}
          target={reveal?.name === name ? target : undefined}
        />
      ))}
    </div>
  );
}
