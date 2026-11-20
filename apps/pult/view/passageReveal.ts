// A cited passage brought into view in a Star's fold (`src/stars/fold.tsx`), whose transcripts
// are no rows of the timeline's list, so upstream's reveal (`AssistantCitationSource`), which
// measures a list item, cannot reach them: the passage resolved in its reply's rendered body by
// upstream's resolver, the fold's scroller moved to it once the fold has stopped growing, and the
// passage pulsed as upstream's live reveal pulses it.
import type { AssistantCitation } from "@t3tools/contracts";

import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";

/** How a reveal ended: shown, not shown (the reader is told), or given up for the reader or a newer one. */
export type RevealOutcome = "shown" | "unshown" | "cancelled";

// Upstream's live reveal's (`AssistantCitationSource.tsx`), so both pulse alike.
const PULSE_MS = 650;
const HOLD_MS = 1575;
const FADE_MS = 450;
const TOTAL_MS = 1.5 * PULSE_MS + HOLD_MS + FADE_MS;
const OPACITY = "--assistant-citation-highlight-opacity";
const PEAK = 0.45;
const HIGHLIGHT = "t3-assistant-citation";
/** The live reveal's room above the passage, at most a third of the viewport. */
const TOP_INSET_PX = 120;
/** Frames a measure must hold to count as settled: the fold's and the list's resize callbacks have run. */
const STEADY_FRAMES = 3;
/** Past this, once every conversation shown is read, the fold never settled or the scroll never reached the passage: told as not shown. */
const GIVE_UP_MS = 5000;

/** The pulse on screen, cleared before the next one starts. */
let clearPulse: (() => void) | undefined;

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** Resolves once `measure` has read the same, not undefined, for `STEADY_FRAMES` frames; undefined if `signal` aborts or the time runs out. */
async function steady<T>(
  measure: () => T | undefined,
  signal: AbortSignal,
  until: number,
): Promise<T | undefined> {
  let last: string | undefined;
  let held = 0;
  while (!signal.aborted && performance.now() < until) {
    await frame();
    const value = measure();
    const key = value === undefined ? undefined : JSON.stringify(value);
    held = key !== undefined && key === last ? held + 1 : 0;
    last = key;
    if (value !== undefined && held >= STEADY_FRAMES - 1) return value;
  }
  return undefined;
}

function pulse(body: HTMLElement, range: Range): void {
  clearPulse?.();
  const highlight = new Highlight(range);
  CSS.highlights.set(HIGHLIGHT, highlight);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const at = (ms: number) => ms / TOTAL_MS;
  const holdEnd = at(TOTAL_MS - FADE_MS);
  const animation = body.animate(
    reduced
      ? [
          { offset: 0, [OPACITY]: PEAK },
          { offset: holdEnd, [OPACITY]: PEAK },
          { offset: 1, [OPACITY]: 0 },
        ]
      : [
          { offset: 0, [OPACITY]: 0 },
          { offset: at(PULSE_MS * 0.5), [OPACITY]: PEAK },
          { offset: at(PULSE_MS), [OPACITY]: 0 },
          { offset: at(PULSE_MS * 1.5), [OPACITY]: PEAK },
          { offset: holdEnd, [OPACITY]: PEAK },
          { offset: 1, [OPACITY]: 0 },
        ],
    { duration: TOTAL_MS, easing: "ease-in-out" },
  );
  const clear = () => {
    animation.cancel();
    // Only this reveal's: a live reveal since then owns the name.
    if (CSS.highlights.get(HIGHLIGHT) === highlight) CSS.highlights.delete(HIGHLIGHT);
    if (clearPulse === clear) clearPulse = undefined;
  };
  clearPulse = clear;
  void animation.finished.then(clear, () => {});
}

/**
 * Brings the citation's passage in the reply `body()` into view in `scroller` and pulses it.
 * Waits while `ready()` is false (conversations above still being read) and until the fold's
 * height and the passage's place hold still, then scrolls with the live reveal's inset, checks
 * the passage is in view, and pulses it; the keyboard goes to the reply unless the reader types.
 * The reader's wheel, touch, key or pointer on the scroller gives it up, as `signal` does.
 * Unshown where the reply never renders, its quote no longer resolves, or nothing settles in time.
 */
export async function revealPassage({
  fold,
  scroller,
  body,
  ready,
  citation,
  signal: given,
}: {
  readonly fold: HTMLElement;
  readonly scroller: HTMLElement;
  readonly body: () => HTMLElement | null;
  readonly ready: () => boolean;
  readonly citation: AssistantCitation;
  readonly signal: AbortSignal;
}): Promise<RevealOutcome> {
  const controller = new AbortController();
  const signal = AbortSignal.any([given, controller.signal]);
  const takeOver = () => controller.abort();
  const events = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
  for (const event of events) scroller.addEventListener(event, takeOver, { passive: true });
  let scrolling = false;
  try {
    // Reads are bounded by the plugin's own timeout, a failed one counting as read.
    while (!ready()) {
      if (signal.aborted) return "cancelled";
      await frame();
    }
    const until = performance.now() + GIVE_UP_MS;
    /** Where the passage starts in the scroller's content, which no scrolling moves. */
    const place = (range: Range) =>
      range.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const settled = await steady(
      () => {
        if (!ready()) return undefined;
        const reply = body();
        if (reply === null || !reply.isConnected) return { height: fold.offsetHeight, top: null };
        const range = resolveAssistantCitationRange(reply, citation);
        return { height: fold.offsetHeight, top: range === null ? null : place(range) };
      },
      signal,
      until,
    );
    if (signal.aborted) return "cancelled";
    const reply = body();
    const range = reply === null ? null : resolveAssistantCitationRange(reply, citation);
    if (settled === undefined || reply === null || range === null) return "unshown";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const inset = Math.min(TOP_INSET_PX, scroller.clientHeight / 3);
    const target = Math.max(
      0,
      Math.min(scroller.scrollHeight - scroller.clientHeight, place(range) - inset),
    );
    scroller.scrollTo({ top: target, behavior: reduced ? "instant" : "smooth" });
    scrolling = true;
    await steady(() => scroller.scrollTop, signal, until);
    if (signal.aborted) return "cancelled";
    const shown = range.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (shown.height <= 0 || shown.bottom <= view.top || shown.top >= view.bottom) return "unshown";
    pulse(reply, range);
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement &&
      (active.isContentEditable || active.matches("input, textarea, select"));
    if (!typing) reply.focus({ preventScroll: true });
    return "shown";
  } finally {
    for (const event of events) scroller.removeEventListener(event, takeOver);
    // A smooth scroll given up stops where it is, as upstream's reveal stops its own.
    if (scrolling && signal.aborted)
      scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
  }
}
