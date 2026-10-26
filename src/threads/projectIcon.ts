import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

/** Upstream's icon colours in their order (`projectIconColors.ts`), as Tailwind's 400 shades, the dark theme's. */
const COLORS: ReadonlyArray<readonly [ProjectIconColor, string]> = [
  ["gray", "#9ca3af"],
  ["red", "#f87171"],
  ["orange", "#fb923c"],
  ["amber", "#fbbf24"],
  ["yellow", "#facc15"],
  ["lime", "#a3e635"],
  ["green", "#4ade80"],
  ["emerald", "#34d399"],
  ["teal", "#2dd4bf"],
  ["cyan", "#22d3ee"],
  ["sky", "#38bdf8"],
  ["blue", "#60a5fa"],
  ["indigo", "#818cf8"],
  ["violet", "#a78bfa"],
  ["purple", "#c084fc"],
  ["fuchsia", "#e879f9"],
  ["pink", "#f472b6"],
  ["rose", "#fb7185"],
];
const COLOR_HEX = new Map(COLORS);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A project's icon for the thread's tab: an SVG as a data URI, drawn after
 * upstream's `ProjectFavicon`. The project's chosen monogram or emoji, or
 * else the monogram upstream derives from the project's name
 * (`projectIdentity.ts`). A Lucide icon, which upstream draws from its icon
 * set, and a favicon, which it fetches from the server, fall back to the
 * derived monogram here.
 */
export function projectIconUri(projectName: string, icon: ProjectIconOverride | null): URI {
  const svg =
    icon?.kind === "emoji"
      ? emojiSvg(icon.emoji)
      : icon?.kind === "monogram"
        ? monogramSvg(icon.text, icon.color)
        : monogramSvg(deriveMonogram(projectName), deriveColor(projectName));
  return URI.parse(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg).replace(/'/g, "%27")}`);
}

/** Upstream's monogram tile: the colour at 14% behind the text in the colour, a quarter-rounded square. */
function monogramSvg(text: string, color: ProjectIconColor): string {
  const hex = COLOR_HEX.get(color) ?? "#60a5fa";
  const length = [...graphemes.segment(text)].length === 1 ? 6 : 12;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<rect width="16" height="16" rx="4" fill="${hex}" fill-opacity="0.14"/>` +
    `<text x="8" y="10.8" text-anchor="middle" fill="${hex}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="8.25" font-weight="700" textLength="${length}" lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>` +
    `</svg>`
  );
}

function emojiSvg(emoji: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<text x="8" y="12.5" text-anchor="middle" font-size="12">${escapeXml(emoji)}</text>` +
    `</svg>`
  );
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
}

/** Upstream's `projectMonogram`: the first word's first glyph, then its first digit, or the last word's first glyph. */
function deriveMonogram(projectName: string): string {
  const words = projectName.normalize("NFKC").trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (firstWord === undefined) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

/** Upstream's `projectColor`: a hash of the lower-cased name over the colours in order. */
function deriveColor(projectName: string): ProjectIconColor {
  const seed = projectName.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % COLORS.length;
  return COLORS[index]?.[0] ?? "blue";
}
