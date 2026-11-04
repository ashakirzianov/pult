import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { request } from "@t3tools/client-runtime/rpc";
import { EnvironmentId, type ProjectIconColor, type ProjectIconOverride, WS_METHODS } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { useSyncExternalStore } from "react";

import { lucideIconSvg, projectFaviconCache } from "../../thread-view/shell/projectIcons.ts";
import { connection } from "../connection/index.ts";
import { whenReady } from "../files/server.ts";
import type { ShellThread } from "./store.ts";

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

/** What a project's icon is drawn from: a project as the store has it. */
export interface ProjectIconSource {
  readonly environmentId: string;
  readonly name: string;
  readonly root: string | null;
  readonly icon: ProjectIconOverride | null;
  readonly faviconPath: string | null;
}

/**
 * A project's icon, for the thread's tab, the cards and the explorer's
 * filter, as upstream's `ProjectFavicon` draws it: the project's chosen
 * monogram, emoji or Lucide icon, or else the favicon the server finds in
 * its root, or else the monogram upstream derives from its name
 * (`projectIdentity.ts`). A Lucide icon or a favicon is fetched on first
 * ask, the derived monogram standing in until it arrives
 * (`projectIcons.onDidChange`); favicons go through upstream's cache, which
 * the thread view shares, so a reload draws them at once. The same image
 * gives the same URI.
 */
export function projectIconUri(project: ProjectIconSource): URI {
  const { icon, name } = project;
  if (icon?.kind === "emoji") return svgUri(emojiSvg(icon.emoji));
  if (icon?.kind === "monogram") return svgUri(monogramSvg(icon.text, icon.color));
  const fetched =
    icon?.kind === "lucide"
      ? image(`lucide|${icon.name}|${icon.color}`, () => lucideIconSvg(icon.name, COLOR_HEX.get(icon.color) ?? "#9ca3af").then(svgDataUrl))
      : project.root === null
        ? undefined
        : image(`favicon|${project.environmentId}|${project.root}|${project.faviconPath ?? ""}`, () => favicon(project.environmentId, project.root ?? "", project.faviconPath));
  return fetched ?? svgUri(monogramSvg(deriveMonogram(name), deriveColor(name)));
}

/** A thread's project as its icon's source. */
export function threadProjectIcon(thread: ShellThread): ProjectIconSource {
  return {
    environmentId: thread.environmentId,
    name: thread.projectName,
    root: thread.projectRoot,
    icon: thread.projectIcon,
    faviconPath: thread.projectFaviconPath,
  };
}

/** Fetched images by what they show: a data URL (or the server's URL, when the cache would not keep it), or null for none. */
const images = new Map<string, string | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/** Fires as fetched icons arrive: the cards re-render (`version`, for `useSyncExternalStore`) and the tabs redraw. */
export const projectIcons = {
  version: () => version,
  onDidChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Re-renders a component drawing project icons as fetched ones arrive. */
export function useProjectIcons(): number {
  return useSyncExternalStore(projectIcons.onDidChange, projectIcons.version);
}

/** How long a failed fetch waits before an ask tries again, as for an environment still connecting. */
const RETRY_MS = 60_000;

/** The image under `key` once fetched; the first ask starts `load`. */
function image(key: string, load: () => Promise<string | null>): URI | undefined {
  if (!asked.has(key)) {
    asked.add(key);
    load().then(
      (src) => settle(key, src),
      () => setTimeout(() => asked.delete(key), RETRY_MS),
    );
  }
  const src = images.get(key);
  return src == null ? undefined : uriOf(src);
}

function settle(key: string, src: string | null): void {
  if (images.get(key) === src) return;
  images.set(key, src);
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * A project's favicon, as upstream's `projectFaviconUrlAtom` fetches it: a
 * signed URL from the server for the root and the project's chosen path,
 * downscaled into the cache; null when the server finds none. A cached one
 * shows while the server is asked again.
 */
async function favicon(environmentId: string, cwd: string, faviconPath: string | null): Promise<string | null> {
  const target = { environmentId: EnvironmentId.make(environmentId), cwd, faviconPath };
  const key = `favicon|${environmentId}|${cwd}|${faviconPath ?? ""}`;
  await projectFaviconCache.hydrate();
  const cached = projectFaviconCache.peek(target);
  if (cached !== null) settle(key, cached);
  await whenReady(environmentId);
  const { relativeUrl } = await connection.run(
    environmentId,
    request(WS_METHODS.assetsCreateUrl, { resource: { _tag: "project-favicon", cwd, ...(faviconPath === null ? {} : { path: faviconPath }) } }),
  );
  const base = connection.credential(environmentId)?.httpBaseUrl;
  if (base === undefined) throw Error(`No connection to ${environmentId}.`);
  const url = new URL(relativeUrl, base).toString();
  if (isProjectFaviconFallbackUrl(url)) return null;
  return projectFaviconCache.resolve(target, url, AbortSignal.timeout(30_000));
}

/** URIs by their source, so the same image gives the same URI. */
const uris = new Map<string, URI>();

function uriOf(src: string): URI {
  let uri = uris.get(src);
  if (uri === undefined) {
    uri = URI.parse(src);
    uris.set(src, uri);
  }
  return uri;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg).replace(/'/g, "%27")}`;
}

function svgUri(svg: string): URI {
  return uriOf(svgDataUrl(svg));
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
