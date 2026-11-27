// A Markdown file's leading YAML mapping as the reader shows it: each entry
// a line, drawn as the monore front draws an object's properties, its rules
// duplicated here (`~/repos/monore`, `lib/browser/property-names.ts`,
// `titles.ts`, `properties.ts`, `refs.ts`, `dates.ts`, `days.ts`, `time.ts`,
// `app/components/type-icon.tsx`, `property-cell.tsx`): the kind by the key's
// last token, the label its other words, a glyph per kind, a date and a time
// formatted, list items as pills, JSON folded, a ref a file chip where it
// names a file (`render.ts`, `chips`). Unlike the front, the file's order is
// kept, no key is hidden, and a ref is Pult's file chip or plain text
// (`pult/decisions`, `reader-frontmatter`). Every text node keeps the source
// position of what it shows, so Cite reads a label's, a date's or a chip's
// selection as the lines it came from.
import type { Element, ElementContent, Properties, Text } from "hast";
import { type Document, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const FENCE = /^(﻿?---[ \t]*(?:\r\n|\n|\r))([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?=\r|\n|$)/m;

const element = (
  tagName: string,
  children: ElementContent[],
  properties: Properties = {},
): Element => ({ type: "element", tagName, properties, children });

type Scalar = "string" | "date" | "time" | "flag" | "ref" | "number" | "json";
type Kind = { readonly kind: Scalar } | { readonly kind: "list"; readonly of: Kind };

const SCALARS: ReadonlyArray<string> = ["date", "time", "flag", "ref", "number", "json"];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `blocked-by` → "Blocked By": words split on dashes, their first letters capitalised. */
const words = (tokens: ReadonlyArray<string>) =>
  tokens
    .filter((token) => token !== "")
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");

/**
 * A key's kind by its last token, a trailing `list` wrapping it, else a
 * string, and its label: its other words capitalised, `monore-` dropped
 * (`blocked-by-ref-list` "Blocked By", `monore-title` "Title"), a key that is
 * all suffix keeping its words (`date` "Date"). A key that is no slug is a
 * string, labelled whole.
 */
function propertyName(key: string): { readonly label: string; readonly kind: Kind } {
  if (!SLUG.test(key)) return { label: words(key.split("-")) || key, kind: { kind: "string" } };
  const tokens = key.split("-");
  let end = tokens.length;
  let lists = 0;
  while (end > 0 && tokens[end - 1] === "list") {
    lists++;
    end--;
  }
  const last = end > 0 ? tokens[end - 1]! : undefined;
  let kind: Kind = { kind: "string" };
  if (last !== undefined && SCALARS.includes(last)) {
    kind = { kind: last as Scalar };
    end--;
  }
  for (let at = 0; at < lists; at++) kind = { kind: "list", of: kind };
  let base = tokens.slice(0, end);
  if (base[0] === "monore" && base.length > 1) base = base.slice(1);
  return { label: words(base.length > 0 ? base : tokens) || key, kind };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `2026-11-25` as "25 Nov 2026"; undefined for text that is no day that exists. */
function shownDay(text: string): string | undefined {
  const match = DAY.exec(text);
  if (match === null) return undefined;
  const at = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) return undefined;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${Number(match[1])}`;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * A stored instant, the one canonical UTC spelling, on the machine's wall
 * clock to the second, `2026-11-25 10:03:12` (the front reads it in the
 * account's zone; the preview has no account); undefined for any other text.
 */
function shownInstant(text: string, timeZone?: string): string | undefined {
  if (!INSTANT.test(text)) return undefined;
  const at = new Date(text);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== text) return undefined;
  const fields = new Map(
    new Intl.DateTimeFormat("en-US", {
      ...(timeZone === undefined ? {} : { timeZone }),
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(fields.get(type));
  const year = fields.get("era") === "BC" ? 1 - field("year") : field("year");
  const yearText = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
  return `${yearText}-${pad(field("month"))}-${pad(field("day"))} ${pad(field("hour"))}:${pad(field("minute"))}:${pad(field("second"))}`;
}

/** monore's bundle types: a folder `<stem>.<type>` whose head is its `bundle.md`. */
const BUNDLE_TYPES: ReadonlyArray<string> = ["iam", "mcp", "api", "img", "task"];

/**
 * The file a frontmatter ref in `document` names, as the front reads one: a
 * path from the monore root as written; a bare one, or one starting `./` or
 * `../`, joined to the folder of `document`, read from the monore root while
 * `document` is in the kept checkout `monoreRoot` (both `pult:` paths), so the
 * click's resolver opens it there; a bundle (`x.task`) its `bundle.md`.
 * `named` is the path the ref spells, the bundle's own for one. Undefined for
 * a spelling that names no file: empty, a `:`, repeated slashes, a `~`, dot
 * segments from the root, a folder, or above the root.
 */
export function frontmatterRefPath(
  ref: string,
  document: string,
  monoreRoot: string | null,
): { readonly named: string; readonly file: string } | undefined {
  if (ref === "" || ref.includes(":")) return undefined;
  const segments = (ref.startsWith("/") ? ref.slice(1) : ref).split("/");
  if (
    segments.some((segment, at) => segment === "~" || (segment === "" && at < segments.length - 1))
  )
    return undefined;
  const last = segments[segments.length - 1]!;
  if (last === "" || last === "." || last === "..") return undefined;
  let named: string;
  if (ref.startsWith("/")) {
    if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
    named = ref;
  } else {
    const inMonore =
      monoreRoot !== null &&
      document.startsWith(monoreRoot.endsWith("/") ? monoreRoot : `${monoreRoot}/`);
    const base = inMonore ? document.slice(monoreRoot.replace(/\/$/, "").length) : document;
    const folder = base.split("/").slice(1, -1);
    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment !== "..") folder.push(segment);
      else if (folder.pop() === undefined) return undefined;
    }
    named = `/${folder.join("/")}`;
  }
  const type = last.lastIndexOf(".") > 0 ? last.slice(last.lastIndexOf(".") + 1) : "";
  return { named, file: BUNDLE_TYPES.includes(type) ? `${named}/bundle.md` : named };
}

type Glyph = "string" | "number" | "boolean" | "date" | "time" | "ref" | "json" | "list";

/** The front's glyphs, 16-unit strokes in `currentColor` (`type-icon.tsx`, `PATHS`). */
const PATHS: Record<Glyph, string> = {
  string: "M3 3h10 M8 3v10",
  number: "M6 2v12 M10 2v12 M2 6h12 M2 10h12",
  boolean: "M3 3h10v10H3z M5.5 8l2 2 3-4",
  date: "M2.5 4h11v9.5h-11z M2.5 7h11 M5.5 2.5v3 M10.5 2.5v3",
  time: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z M8 5v3l2 1.5",
  ref: "M9 3h4v4 M13 3L7 9 M11 9.5V13H3V5h3.5",
  json: "M6 2.5H5a1.5 1.5 0 0 0-1.5 1.5v2.5L2.5 8l1 1.5V12A1.5 1.5 0 0 0 5 13.5h1 M10 2.5h1A1.5 1.5 0 0 1 12.5 4v2.5l1 1.5-1 1.5V12a1.5 1.5 0 0 1-1.5 1.5h-1",
  list: "M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.5 4h.5 M2.5 8h.5 M2.5 12h.5",
};

/** Each glyph redrawn for a list's badge, an 8-unit box in the icon's bottom-right quarter (`type-icon.tsx`, `BADGES`). */
const BADGES: Record<Glyph, { readonly stroke: string; readonly fill?: string }> = {
  string: { stroke: "M1.5 1.5h6 M4.5 1.5v6" },
  number: { stroke: "M2.5 .5v7 M5.5 .5v7 M.5 2.5h7 M.5 5.5h7" },
  boolean: { stroke: "M1 4.5l2 2 4-5" },
  date: { stroke: "M.5 1.5h7v6h-7z", fill: "M.5 1.5h7v2h-7z" },
  time: { stroke: "M4 .75a3.25 3.25 0 1 0 0 6.5a3.25 3.25 0 1 0 0-6.5z M4 2.5v1.5h1.5" },
  ref: { stroke: "M1.5 7.5l5-5 M3 1.5h4.5v4.5" },
  json: { stroke: "M3 1.5H1.5v6H3 M1.5 4.5H.5 M5 1.5h1.5v6H5 M6.5 4.5h1" },
  list: { stroke: "M3 1.5h4.5 M3 4.5h4.5 M3 7.5h4.5 M.75 1.5h0 M.75 4.5h0 M.75 7.5h0" },
};

const GLYPHS: Record<Scalar, Glyph> = {
  string: "string",
  number: "number",
  flag: "boolean",
  date: "date",
  time: "time",
  ref: "ref",
  json: "json",
};

const path = (d: string, properties: Properties = {}) => element("path", [], { d, ...properties });

/**
 * A kind's icon: its glyph, or a list's glyph badged with its items' kind's,
 * the base cut away around the badge by the mask `mask`, as the front draws it.
 */
function icon(kind: Kind, mask: string): Element {
  let item = kind;
  while (item.kind === "list") item = item.of;
  const glyph = GLYPHS[item.kind];
  const badge = BADGES[glyph];
  const children =
    kind.kind !== "list"
      ? [path(PATHS[glyph])]
      : [
          element(
            "mask",
            [
              element("rect", [], { width: "16", height: "16", fill: "white", stroke: "none" }),
              element("rect", [], {
                x: "7",
                y: "7",
                width: "10",
                height: "10",
                rx: "2",
                fill: "black",
                stroke: "none",
              }),
            ],
            { id: mask, maskUnits: "userSpaceOnUse", x: "0", y: "0", width: "16", height: "16" },
          ),
          path(PATHS.list, { mask: `url(#${mask})` }),
          element(
            "g",
            [
              path(badge.stroke),
              ...(badge.fill === undefined
                ? []
                : [path(badge.fill, { fill: "currentColor", stroke: "none" })]),
            ],
            { transform: "translate(8 8)" },
          ),
        ];
  return element("svg", children, {
    className: ["pult-reader-kind"],
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.25",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ariaHidden: "true",
  });
}

/** Splits a leading YAML mapping from Markdown, preserving the body's source positions. */
export function markdownFrontmatter(source: string) {
  const match = FENCE.exec(source);
  if (match?.index !== 0) return { markdown: source };
  const yamlStart = match[1]!.length;
  const yaml = match[2]!;
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter, intAsBigInt: true });
  if (doc.errors.length !== 0 || !isMap(doc.contents)) return { markdown: source };

  /** `value`, placed where `node` is in the source, so Cite reads it as `node`'s lines. */
  const placed = (node: unknown, value: string): Text => {
    const range = isNode(node) ? (node.range ?? undefined) : undefined;
    if (range === undefined) return { type: "text", value };
    const point = (offset: number) => {
      const { line, col } = lineCounter.linePos(offset);
      return { line: line + 1, column: col, offset: yamlStart + offset };
    };
    return { type: "text", value, position: { start: point(range[0]), end: point(range[1]) } };
  };

  /** A node's own text: a scalar's value, anything else its source. */
  const text = (node: unknown): Text => {
    const range = isNode(node) ? (node.range ?? undefined) : undefined;
    return placed(
      node,
      isScalar(node)
        ? String(node.value)
        : range === undefined
          ? "null"
          : yaml.slice(range[0], range[1]),
    );
  };

  /** A value as an untyped key's: text, nested lists and mappings. */
  const plain = (node: unknown): ElementContent[] => {
    if (isMap(node) && node.items.length > 0) return [entries(node.items)];
    if (isSeq(node) && node.items.length > 0)
      return [
        element(
          "ul",
          node.items.map((item) => element("li", plain(item))),
        ),
      ];
    return [text(node)];
  };

  const span = (className: string, children: ElementContent[], properties: Properties = {}) =>
    element("span", children, { className: [className], ...properties });

  /** A value drawn as `kind` draws it, or undefined where it does not fit. */
  const typed = (node: unknown, kind: Kind): ElementContent[] | undefined => {
    const value = isScalar(node) ? node.value : undefined;
    switch (kind.kind) {
      case "string":
        return typeof value === "string" ? [text(node)] : undefined;
      case "date": {
        const day = typeof value === "string" ? shownDay(value) : undefined;
        return day === undefined
          ? undefined
          : [span("pult-reader-date", [placed(node, day)], { title: value as string })];
      }
      case "time": {
        const local = typeof value === "string" ? shownInstant(value) : undefined;
        return local === undefined
          ? undefined
          : [span("pult-reader-time", [placed(node, local)], { title: value as string })];
      }
      case "flag":
        return typeof value === "boolean" ? [span("pult-reader-mono", [text(node)])] : undefined;
      case "number":
        return typeof value === "number" || typeof value === "bigint"
          ? [span("pult-reader-mono", [text(node)])]
          : undefined;
      case "ref":
        // The pane draws it as a file chip where it names one (`render.ts`, `chips`).
        return typeof value === "string"
          ? [span("pult-reader-ref", [text(node)], { dataPultRef: value })]
          : undefined;
      case "json": {
        const json = jsonText(doc, node);
        return json === undefined
          ? undefined
          : [
              element(
                "details",
                [element("summary", [placed(node, "json")]), element("pre", [placed(node, json)])],
                { className: ["pult-reader-json"] },
              ),
            ];
      }
      case "list":
        return isSeq(node)
          ? [
              span(
                "pult-reader-pills",
                node.items.map((item) =>
                  span("pult-reader-pill", typed(item, kind.of) ?? plain(item)),
                ),
              ),
            ]
          : undefined;
    }
  };

  let masks = 0;
  const entries = (items: ReadonlyArray<{ key: unknown; value: unknown }>, top = false): Element =>
    element(
      "dl",
      items.map(({ key, value }) => {
        if (!top) return element("div", [element("dt", [text(key)]), element("dd", plain(value))]);
        const name = isScalar(key) ? String(key.value) : text(key).value;
        const { label, kind } = propertyName(name);
        // An empty value is drawn as written, under its kind's glyph, as the front draws it.
        const empty = value === null || (isScalar(value) && value.value === null);
        const drawn = empty ? undefined : typed(value, kind);
        // A value that does not fit its kind is drawn as an untyped one, its glyph as the front's.
        const shown: Kind =
          empty || drawn !== undefined
            ? kind
            : { kind: isScalar(value) && typeof value.value === "string" ? "string" : "json" };
        return element(
          "div",
          [
            element("dt", [icon(shown, `pult-reader-knockout-${masks++}`), placed(key, label)]),
            element("dd", drawn ?? plain(value)),
          ],
          { title: name },
        );
      }),
    );

  const block = element("section", [entries(doc.contents.items, true)], {
    className: ["pult-reader-frontmatter"],
    ariaLabel: "Frontmatter",
  });
  const markdown = match[0].replace(/[^\r\n]/g, " ") + source.slice(match[0].length);
  return { markdown, block, end: match[0].length };
}

/** A value as the front's JSON, two spaces deep; undefined when it holds an integer JSON's numbers cannot hold. */
function jsonText(doc: Document, node: unknown): string | undefined {
  let exact = true;
  const text = JSON.stringify(
    isNode(node) ? node.toJS(doc) : null,
    (_key, value: unknown) => {
      if (typeof value !== "bigint") return value;
      if (!Number.isSafeInteger(Number(value))) exact = false;
      return Number(value);
    },
    2,
  );
  return exact ? text : undefined;
}
