import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_MIN_WIDTH,
  THREAD_DETAILS_CARD_WIDTH,
} from "~/components/chat/threadDetailsCardLayout";

const WIDTH_KEY = "pult-shell.details.width";
const MAX_WIDTH = 560;

const clamp = (width: number) =>
  Math.round(Math.min(MAX_WIDTH, Math.max(THREAD_DETAILS_CARD_MIN_WIDTH, width)));

function storedWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY) ?? Number.NaN);
  return Number.isFinite(stored) ? clamp(stored) : THREAD_DETAILS_CARD_WIDTH;
}

let width = storedWidth();
const listeners = new Set<() => void>();

/** The right panel's width: one for the whole app, followed live by every view, kept for the page's next start once a drag ends. */
export const detailsCardWidth = {
  inset: THREAD_DETAILS_CARD_GAP,
  minimum: THREAD_DETAILS_CARD_MIN_WIDTH,
  maximum: MAX_WIDTH,
  get: () => width,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: number) {
    const clamped = clamp(next);
    if (clamped === width) return;
    width = clamped;
    for (const listener of listeners) listener();
  },
  keep: () => localStorage.setItem(WIDTH_KEY, String(width)),
};
