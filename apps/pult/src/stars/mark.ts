import { projectDrafts, threadsWithUnsentMessages } from "../panel/drafts.ts";
import { workbenchColorScheme } from "../theme.ts";
import { threadStore } from "../threads/store.ts";
import { finishedUntil, type StarLook, starLook } from "./look.ts";
import { starStore } from "./model.ts";
import { tintOf } from "./record.ts";
import type { Star } from "./stars.ts";

/**
 * `pult-star`'s stills, by path: `<tint>/<look>.png`, its light on
 * transparency, for dark themes, and `<tint>/<look>.ink.png` for light ones.
 * Files, not inlined, so the tab's icon and the card share one URL each.
 */
const STILLS = import.meta.glob<string>("../../assets/star/*/*.png", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

type Scheme = "light" | "dark";

/**
 * A Star's mark in a look, a still in v1 (the playback is
 * `pult/issues/durable-agent-animations`'s), as an image URL: the still
 * `pult-star` baked for its tint, look and the theme's scheme where there is
 * one, else a glowing disc in the tint.
 */
function markUrl(tint: string, look: StarLook, scheme: Scheme): string {
  const still = STILLS[`../../assets/star/${tint}/${look}${scheme === "light" ? ".ink" : ""}.png`];
  if (still !== undefined) return new URL(still, window.location.href).href;
  const { hue } = tintOf(tint);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><radialGradient id="g"><stop offset="0" stop-color="hsl(${hue} 90% 85%)"/><stop offset="0.45" stop-color="hsl(${hue} 85% 62%)" stop-opacity="0.85"/><stop offset="1" stop-color="hsl(${hue} 85% 55%)" stop-opacity="0"/></radialGradient></defs><circle cx="16" cy="16" r="16" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The Stars' looks, by id, and the workbench theme's scheme, which pick their marks. */
export interface StarMarks {
  readonly looks: ReadonlyMap<string, StarLook>;
  readonly scheme: Scheme;
}

/** The longest the page waits between looks at a finished Star's minute: a timer's clock stops while the machine sleeps. */
const CLOCK_CHECK_MS = 60_000;

let marks: StarMarks = { looks: new Map(), scheme: "dark" };
const listeners = new Set<() => void>();
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Derives every Star's look again, telling the listeners when one changed, and looks again when a finished minute ends. */
function update(): void {
  clearTimeout(timer);
  timer = undefined;
  const now = Date.now();
  const inputs = {
    threads: threadStore.get().threads,
    unsent: threadsWithUnsentMessages.get(),
    drafts: projectDrafts.get(),
    now,
  };
  const stars = starStore.get();
  const looks = new Map(stars.map((star) => [star.id, starLook(star, inputs)]));
  const ends = stars.flatMap((star) => {
    const until = star.current === null ? null : finishedUntil(star.current);
    return until !== null && until > now ? [until] : [];
  });
  if (ends.length > 0)
    timer = setTimeout(update, Math.min(Math.min(...ends) - now + 1, CLOCK_CHECK_MS));
  if (
    looks.size === marks.looks.size &&
    [...looks].every(([id, look]) => marks.looks.get(id) === look)
  )
    return;
  marks = { ...marks, looks };
  for (const listener of listeners) listener();
}

/** Follows the threads, the Stars, the composers and the theme, from the first subscriber on. */
function start(): void {
  started = true;
  threadStore.subscribe(update);
  starStore.subscribe(update);
  threadsWithUnsentMessages.subscribe(update);
  projectDrafts.subscribe(update);
  void workbenchColorScheme().then((scheme) => {
    const apply = () => {
      marks = { ...marks, scheme: scheme.current() };
      for (const listener of listeners) listener();
    };
    apply();
    scheme.onDidChange(apply);
  });
  update();
}

/** The Stars' marks for `useSyncExternalStore`: the same object until a look or the scheme changes. */
export const starMarks = {
  get: (): StarMarks => marks,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!started) start();
    return () => listeners.delete(listener);
  },
};

/** The mark `star` shows now, by `starMarks`' latest: its look's still for its tint and the theme. */
export function starMarkUrl(star: Pick<Star, "id" | "tint">, current: StarMarks = marks): string {
  return markUrl(star.tint, current.looks.get(star.id) ?? "asleep", current.scheme);
}
