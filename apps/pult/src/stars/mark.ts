import { getService, IThemeService } from "@codingame/monaco-vscode-api";
import { errorForeground } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colors/baseColors";
import { isDark } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/theme";

import { threadStore } from "../threads/store.ts";
import { flatStill } from "./flat/star.ts";
import markCss from "./flat/star.css?raw";
import { LOOK_STATES, type StarLook, starLook } from "./look.ts";
import { starStore } from "./model.ts";
import { cardRows, type Star, workingChannels } from "./stars.ts";

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
 * The Stars' looks and their numbers of planets, the channels that work
 * (`workingChannels`), by id, and what the workbench theme gives their marks:
 * its scheme, which picks the tint's colour, and its error colour, the
 * troubled ring's, which the tab's still resolves (the square's mark reads
 * `--vscode-errorForeground` itself).
 */
export interface StarMarks {
  readonly looks: ReadonlyMap<string, StarLook>;
  readonly planets: ReadonlyMap<string, number>;
  readonly scheme: Scheme;
  readonly error: string;
}

/** Dark 2026's, the shell's default theme (`src/configuration.json`), until the theme service is up. */
let marks: StarMarks = { looks: new Map(), planets: new Map(), scheme: "dark", error: "#f48771" };
const listeners = new Set<() => void>();
let started = false;

function tell(): void {
  for (const listener of listeners) listener();
}

/** Whether two maps by Star id hold the same values. */
const same = <Value>(left: ReadonlyMap<string, Value>, right: ReadonlyMap<string, Value>) =>
  left.size === right.size && [...left].every(([id, value]) => right.get(id) === value);

/** Derives every Star's look and number of planets again, telling the listeners when one changed. */
function update(): void {
  const { threads } = threadStore.get();
  const stars = starStore.get();
  const looks = new Map(stars.map((star) => [star.id, starLook(star, threads)]));
  const planets = new Map(
    stars.map((star) => [star.id, workingChannels(cardRows(star, threads), threads).size]),
  );
  if (same(looks, marks.looks) && same(planets, marks.planets)) return;
  marks = { ...marks, looks, planets };
  tell();
}

/** Follows the threads, the Stars and the theme, from the first subscriber on. */
function start(): void {
  started = true;
  threadStore.subscribe(update);
  starStore.subscribe(update);
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

/** The number of planets `star`'s mark shows now, by `starMarks`' latest: its channels that work. */
export function starPlanetsOf(star: Pick<Star, "id">, current: StarMarks = marks): number {
  return current.planets.get(star.id) ?? 0;
}

/** The look `star` wears now, by `starMarks`' latest; asleep until its threads are read. */
export function starLookOf(star: Pick<Star, "id">, current: StarMarks = marks): StarLook {
  return current.looks.get(star.id) ?? "asleep";
}

/**
 * The tab's stills, by what each resolves: one URL per colour, error colour,
 * look and number of planets, so the tab's label, which is keyed on it,
 * changes only with them.
 */
const stills = new Map<string, string>();

/**
 * The mark as an image, for the tab's icon, which the workbench paints as a
 * background image (`src/threads/pane.tsx`): the mark's still, one SVG with
 * nothing moving, carrying the mark's stylesheet and its colours resolved.
 */
function still(color: string, error: string, look: StarLook, planets: number): string {
  const key = JSON.stringify([color, error, look, planets]);
  const known = stills.get(key);
  if (known !== undefined) return known;
  const svg = flatStill(
    LOOK_STATES[look],
    planets,
    `${markCss}\n.flat-star { color: ${color}; --err: ${error}; }`,
  );
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  stills.set(key, url);
  return url;
}

/** The still of `look` with `planets` in `tint` and the theme's colours: a channel's row's (`src/details/StarDetails.tsx`), its own planet or none. */
export function lookStillUrl(
  tint: string,
  look: StarLook,
  planets: number,
  current: StarMarks = marks,
): string {
  return still(tintColor(tint, current.scheme), current.error, look, planets);
}

/** The still `star` shows now, by `starMarks`' latest: its look and its planets in its tint and the theme's colours, wherever its mark is an image (the tab, a poster's card). */
export function starStillUrl(star: Pick<Star, "id" | "tint">, current: StarMarks = marks): string {
  return lookStillUrl(star.tint, starLookOf(star, current), starPlanetsOf(star, current), current);
}
