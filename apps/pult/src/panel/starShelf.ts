import { starEnabled } from "../stars/settings.ts";
import type { Star } from "../stars/stars.ts";

const key = "pult-shell.panel.show-sleeping-stars";
let showSleeping = localStorage.getItem(key) === "true";
const listeners = new Set<() => void>();

export const sleepingStarsShown = {
  get: () => showSleeping,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function setSleepingStarsShown(next: boolean): void {
  localStorage.setItem(key, String(next));
  showSleeping = next;
  for (const listener of listeners) listener();
}

/** The shelf and the keyboard jumps reach the same Stars. A Star with no open channel is asleep. */
export function starsOnShelf(stars: ReadonlyArray<Star>): ReadonlyArray<Star> {
  if (!starEnabled.get()) return [];
  return showSleeping ? stars : stars.filter((star) => star.channels.length > 0);
}
