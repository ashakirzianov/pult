import { getService, IThemeService } from "@codingame/monaco-vscode-api";
import { errorForeground } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colors/baseColors";
import { isDark } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/theme";

import { projectDrafts, threadsWithUnsentMessages } from "../panel/drafts.ts";
import { threadStore } from "../threads/store.ts";
import { flatStill } from "./flat/star.ts";
import markCss from "./flat/star.css?raw";
import { type StarLook, starFinishedUntil, starLook } from "./look.ts";
import { starStore } from "./model.ts";
import type { Star } from "./stars.ts";

type Scheme = "light" | "dark";

/** The tints a Star takes, as `pult-star`'s Curls sketch names them, each by its hue in degrees: what the page draws and offers. */
export const TINTS = [
  { name: "amber", hue: 40 },
  { name: "coral", hue: 12 },
  { name: "rose", hue: 340 },
  { name: "violet", hue: 275 },
  { name: "indigo", hue: 235 },
  { name: "sky", hue: 200 },
  { name: "mint", hue: 155 },
] as const;

export const DEFAULT_TINT: (typeof TINTS)[number]["name"] = "amber";

/** A tint by name, the default for one Pult does not know: the record's tint is written as given. */
export function tintOf(name: string) {
  return TINTS.find((tint) => tint.name === name) ?? TINTS[0];
}

/** The colour a Star's mark is drawn in: its tint's hue, lighter on a dark theme and deeper on a light one. */
export function tintColor(tint: string, scheme: Scheme): string {
  const { hue } = tintOf(tint);
  return scheme === "dark" ? `hsl(${hue} 90% 62%)` : `hsl(${hue} 78% 44%)`;
}

/**
 * The Stars' looks, by id, and what the workbench theme gives their marks:
 * its scheme, which picks the tint's colour, and its error colour, the
 * troubled ring's, which the tab's still resolves (the card's mark reads
 * `--vscode-errorForeground` itself).
 */
export interface StarMarks {
  readonly looks: ReadonlyMap<string, StarLook>;
  readonly scheme: Scheme;
  readonly error: string;
}

/** The longest the page waits between looks at a finished Star's minute: a timer's clock stops while the machine sleeps. */
const CLOCK_CHECK_MS = 60_000;

/** Dark Modern's, the shell's default theme (`src/configuration.json`), until the theme service is up. */
let marks: StarMarks = { looks: new Map(), scheme: "dark", error: "#f85149" };
const listeners = new Set<() => void>();
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function tell(): void {
  for (const listener of listeners) listener();
}

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
    const until = starFinishedUntil(star);
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
  tell();
}

/** Follows the threads, the Stars, the composers and the theme, from the first subscriber on. */
function start(): void {
  started = true;
  threadStore.subscribe(update);
  starStore.subscribe(update);
  threadsWithUnsentMessages.subscribe(update);
  projectDrafts.subscribe(update);
  void getService(IThemeService).then((themes) => {
    const apply = () => {
      const theme = themes.getColorTheme();
      const scheme = isDark(theme.type) ? "dark" : "light";
      const error = theme.getColor(errorForeground)?.toString();
      if (error === undefined)
        throw new Error(`the theme ${theme.label} resolves no errorForeground`);
      if (scheme === marks.scheme && error === marks.error) return;
      marks = { ...marks, scheme, error };
      tell();
    };
    apply();
    themes.onDidColorThemeChange(apply);
  });
  update();
}

/** The Stars' marks for `useSyncExternalStore`: the same object until a look, the scheme or the error colour changes. */
export const starMarks = {
  get: (): StarMarks => marks,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!started) start();
    return () => listeners.delete(listener);
  },
};

/** The look `star` wears now, by `starMarks`' latest; asleep until its threads are read. */
export function starLookOf(star: Pick<Star, "id">, current: StarMarks = marks): StarLook {
  return current.looks.get(star.id) ?? "asleep";
}

/**
 * The tab's stills, by what each resolves: one URL per colour, error colour
 * and look, so the tab's label, which is keyed on it, changes only with them.
 */
const stills = new Map<string, string>();

/**
 * The mark as an image, for the tab's icon, which the workbench paints as a
 * background image (`src/threads/pane.tsx`): the mark's still, one SVG with
 * nothing moving, carrying the mark's stylesheet and its colours resolved.
 */
function still(color: string, error: string, look: StarLook): string {
  const key = JSON.stringify([color, error, look]);
  const known = stills.get(key);
  if (known !== undefined) return known;
  const svg = flatStill(look, `${markCss}\n.flat-star { color: ${color}; --err: ${error}; }`);
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  stills.set(key, url);
  return url;
}

/** The still `star` shows now in the tab, by `starMarks`' latest: its look in its tint and the theme's colours. */
export function starStillUrl(star: Pick<Star, "id" | "tint">, current: StarMarks = marks): string {
  return still(tintColor(star.tint, current.scheme), current.error, starLookOf(star, current));
}
