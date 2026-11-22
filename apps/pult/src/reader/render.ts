// A project's HTML file as its reader shows it (`src/reader/pane.ts`): the
// page with its own CSS and inline images, in a frame of its own, with no
// script run and nothing fetched or navigated to. The buffer is parsed here,
// in JavaScript, and the frame's document built node by node from the tree,
// so the browser never parses the page's markup nor sees a URL of it. A
// Markdown file is parsed to the same tree (`markdown.ts`) and built the same.
import { parse, type DefaultTreeAdapterTypes } from "parse5";

import { markdownOrigins, markdownTree, type SourceLocation } from "./markdown.ts";
import { type Passage, selectedPassage, type SourceText } from "./selection.ts";

type Node = DefaultTreeAdapterTypes.ChildNode;

/**
 * The frame document's policy, set before any of the page is in it: inline
 * styles, and images, fonts and media from `data:` URLs, and nothing else;
 * remote styles, fonts, images and CSS `url()`s are refused before any
 * request. The sandbox (`createReaderFrame`) runs no script.
 */
const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** Elements left out with their contents: scripts, a base URL, loaders and nested documents, and inert templates. */
const DROPPED = new Set([
  "script",
  "base",
  "link",
  "iframe",
  "frame",
  "frameset",
  "fencedframe",
  "portal",
  "object",
  "embed",
  "applet",
  "template",
]);

/** Attributes holding a URL the browser would load or navigate to, kept only as a `data:` URL or a fragment of the page. */
const URL_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "href",
  "poster",
  "data",
  "action",
  "formaction",
  "background",
  "codebase",
  "archive",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "manifest",
  "icon",
  "ping",
  "srcdoc",
]);

/** A script element's types that run: none, a module, or a JavaScript MIME type (the MIME Sniffing Standard's). */
const SCRIPT_TYPE =
  /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/(?:jscript|livescript))$/i;

/** A URL attribute's value as the URL parser reads it: no tab or newline anywhere, no leading space or control character. */
const urlText = (value: string) =>
  value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000- ]+/, "")
    .toLowerCase();

/**
 * The attribute's value as the frame gets it, or none to leave it out: no
 * event handler; a URL only as `data:` or a fragment of the page, but a
 * link's target, which stays a link, for its look, pointing at the page's
 * top, so no menu, preconnect or default action of the browser's leaves it.
 */
function kept(element: string, name: string, value: string): string | undefined {
  if (name.startsWith("on")) return undefined;
  if (!URL_ATTRIBUTES.has(name)) return value;
  if (name === "ping" || name === "srcdoc") return undefined;
  const url = urlText(value);
  if (url.startsWith("#")) return value;
  if (name === "href" && (element === "a" || element === "area")) return "#";
  return url.startsWith("data:") ? value : undefined;
}

interface Built {
  scripts: boolean;
  readonly origins: WeakMap<Text, SourceText>;
  /** Where a text node of `value` at `at` came from. */
  readonly origin: (at: SourceLocation, value: string) => SourceText;
}

/** Where each HTML text node of `source` came from: its text there, as written when it decodes nothing. */
const htmlOrigins = (source: string) => (at: SourceLocation, value: string) => {
  const text = source.slice(at.startOffset, at.endOffset);
  return { line: at.startLine, source: text, literal: text.replace(/\r\n?/g, "\n") === value };
};

function build(doc: Document, parent: ParentNode, nodes: readonly Node[], built: Built): void {
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      const { value, sourceCodeLocation: at } = node as DefaultTreeAdapterTypes.TextNode;
      const text = doc.createTextNode(value);
      if (at) built.origins.set(text, built.origin(at, value));
      parent.append(text);
      continue;
    }
    if (!("tagName" in node)) continue; // comments and the doctype
    const name = node.tagName;
    if (name === "script") {
      const type = node.attrs.find((attr) => attr.name === "type")?.value.trim() ?? "";
      if (SCRIPT_TYPE.test(type)) built.scripts = true;
    }
    if (node.attrs.some((attr) => attr.name.startsWith("on"))) built.scripts = true;
    if (DROPPED.has(name)) continue;
    if (name === "meta" && node.attrs.some((attr) => attr.name === "http-equiv")) continue;
    let element: Element;
    try {
      element = doc.createElementNS(node.namespaceURI, name);
    } catch {
      // A name the parser takes and the DOM refuses: its contents, without it.
      build(doc, parent, node.childNodes, built);
      continue;
    }
    for (const attr of node.attrs) {
      const value = kept(name, attr.name, attr.value);
      if (value === undefined) continue;
      try {
        if (attr.namespace === undefined) element.setAttribute(attr.name, value);
        else
          element.setAttributeNS(
            attr.namespace,
            attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name,
            value,
          );
      } catch {
        // A name the DOM refuses is dropped.
      }
    }
    build(doc, element, node.childNodes, built);
    parent.append(element);
  }
}

/** The frame a reader shows its page in, `show` rendering a revision of the page's text. */
export interface ReaderFrame {
  readonly element: HTMLIFrameElement;
  /**
   * Renders `source`, a page or, `markdown`, a Markdown file, at the
   * reader's scroll position or, `fresh`, at the top; whether the page has
   * scripts, which never run here. Undefined when a later `show` superseded
   * it before it rendered.
   */
  show(
    source: string,
    options?: { readonly fresh?: boolean; readonly markdown?: boolean },
  ): Promise<{ readonly scripts: boolean } | undefined>;
  /** The reader's selection in the page shown, with the lines of the source given to `show` it came from. */
  selection(): Passage | undefined;
  /**
   * The source line at the top of the reader's view: the first text there,
   * the line of it showing for a literal one, or for text made of no source
   * the nearest earlier text's; none above any, or before a render.
   */
  topLine(): number | undefined;
  /** Scrolls the page so the text of the source's `line`, else the nearest earlier text, is at the top of the view: the page shown, or the next one rendered while the frame loads. */
  reveal(line: number): void;
}

/** The page's rendered text nodes, in document order, each with where it came from, if anywhere. */
function* placedText(doc: Document, origins: WeakMap<Text, SourceText>) {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim() === "" || text.parentElement?.checkVisibility() !== true) continue;
    yield { text, origin: origins.get(text) };
  }
}

const LINE_BREAK = /\r\n?|\n/g;

/** Where each line of a text node's data starts. */
const lineStarts = (data: string) => [
  0,
  ...[...data.matchAll(LINE_BREAK)].map((m) => m.index + m[0].length),
];

/** The box of the text node's characters from `from` to `to`. */
function boxOf(text: Text, from: number, to: number): DOMRect {
  const range = text.ownerDocument.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  return range.getBoundingClientRect();
}

/**
 * A frame for a page, to be attached before its first `show`: sandboxed with
 * no script allowed and the shell's origin, so the shell reads and builds its
 * document; its policy refuses every request but `data:` URLs; a link's
 * click, a form's submit and a drop never navigate it, and a link to a
 * fragment of the page scrolls to it.
 */
export function createReaderFrame(options?: {
  /** Each document the frame loads, guarded already, for the reader's own listeners on it. */
  readonly onDocument?: (doc: Document) => void;
}): ReaderFrame {
  const element = document.createElement("iframe");
  element.className = "pult-reader-frame";
  element.setAttribute("sandbox", "allow-same-origin");
  element.setAttribute("referrerpolicy", "no-referrer");
  element.setAttribute("allow", "");
  let current: Document | undefined;
  let loading: Array<(doc: Document) => void> = [];
  let latest = 0;
  let last: { source: string; markdown: boolean } | undefined;
  // Where the reader is in the page, kept across the document's reloads.
  let position = { top: 0, left: 0 };
  let shown: Document | undefined;
  const origins = new WeakMap<Text, SourceText>();
  // A line to bring the page shown to once it renders.
  let revealing: number | undefined;

  /** Brings the page shown to the line `reveal` asked for. */
  const revealShown = () => {
    const line = revealing!;
    revealing = undefined;
    let target: { text: Text; offset: number; line: number } | undefined;
    // A line of markup with no text of its own (a fence, `$$`, a tag) opens the text right after it.
    let covered = false;
    let next: Text | undefined;
    for (const { text, origin } of placedText(shown!, origins)) {
      if (origin === undefined) continue;
      const end = origin.line + (origin.source.match(LINE_BREAK)?.length ?? 0);
      covered ||= origin.line <= line && line <= end;
      if (origin.line === line + 1) next ??= text;
      if (origin.line > line || origin.line <= (target?.line ?? -1)) continue;
      const starts = origin.literal ? lineStarts(text.data) : [0];
      const offset = starts[Math.min(line - origin.line, starts.length - 1)]!;
      target = { text, offset, line: origin.line };
    }
    const written = last?.source.split(LINE_BREAK)[line - 1]?.trim() ?? "";
    if (!covered && written !== "" && next !== undefined)
      target = { text: next, offset: 0, line: line + 1 };
    const scroller = shown!.scrollingElement;
    if (target === undefined || scroller === null) return;
    const { text, offset } = target;
    scroller.scrollTop =
      boxOf(text, offset, Math.min(offset + 1, text.length)).top + scroller.scrollTop;
    position = { top: scroller.scrollTop, left: scroller.scrollLeft };
  };

  // Each load of the frame's document is guarded and followed for the
  // reader's place: its first, and any the browser makes again, as for a
  // frame taken out of the page and put back (the workbench detaches a
  // hidden pane), which shows the page again where the reader was.
  element.addEventListener("load", () => {
    const doc = element.contentDocument;
    if (doc === null || !doc.URL.startsWith("about:srcdoc")) return;
    guard(doc, element);
    options?.onDocument?.(doc);
    doc.addEventListener("scroll", () => {
      const scroller = doc.scrollingElement;
      if (scroller !== null) position = { top: scroller.scrollTop, left: scroller.scrollLeft };
    });
    current = doc;
    const waiting = loading;
    loading = [];
    for (const resolve of waiting) resolve(doc);
    if (waiting.length === 0 && last !== undefined) void frame.show(last.source, last);
  });

  /** The frame's document once loaded, waited for while the browser loads it (again). */
  const frameDocument = (): Promise<Document> =>
    current !== undefined && current === element.contentDocument
      ? Promise.resolve(current)
      : new Promise((resolve) => loading.push(resolve));
  // A `srcdoc` document is in no-quirks mode whatever its doctype, so every page renders in it.
  // Its base URL would be the shell's: its own makes a fragment the page's, and no other relative URL resolves.
  element.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><base href="about:srcdoc">`;

  const frame: ReaderFrame = {
    element,
    async show(source, options) {
      const revision = ++latest;
      const markdown = options?.markdown === true;
      last = { source, markdown };
      const tree = markdown
        ? await markdownTree(source, element)
        : parse(source, { scriptingEnabled: false, sourceCodeLocationInfo: true });
      const doc = await frameDocument();
      if (revision !== latest) return undefined;
      const origin = (markdown ? markdownOrigins : htmlOrigins)(source);
      const built: Built = { scripts: false, origins, origin };
      const html = tree.childNodes.find((node) => "tagName" in node && node.tagName === "html");
      if (html === undefined || !("tagName" in html)) return built;
      const root = doc.createElement("html");
      if (html.attrs.some((attr) => attr.name.startsWith("on"))) built.scripts = true;
      for (const attr of html.attrs) {
        const value = kept("html", attr.name, attr.value);
        if (value !== undefined) root.setAttribute(attr.name, value);
      }
      build(doc, root, html.childNodes, built);
      // The policy's and the base URL's elements lead the page's head, where the frame's parser applied them.
      const head = root.querySelector(":scope > head");
      head?.prepend(...doc.head.querySelectorAll(":scope > meta[http-equiv], :scope > base"));
      const scroller = doc.scrollingElement;
      if (options?.fresh) position = { top: 0, left: 0 };
      else if (doc === shown && scroller !== null)
        position = { top: scroller.scrollTop, left: scroller.scrollLeft };
      shown = doc;
      const { top, left } = position;
      doc.replaceChild(root, doc.documentElement);
      doc.scrollingElement?.scrollTo(left, top);
      if (revealing !== undefined) revealShown();
      return built;
    },
    selection() {
      return shown === undefined || shown !== element.contentDocument
        ? undefined
        : selectedPassage(shown, origins);
    },
    topLine() {
      if (shown === undefined || shown !== element.contentDocument) return undefined;
      let earlier: number | undefined;
      for (const { text, origin } of placedText(shown, origins)) {
        const box = boxOf(text, 0, text.length);
        if (box.bottom <= 0) {
          earlier = origin?.line ?? earlier;
          continue;
        }
        // Text below the whole view leaves it to what came before, generated content filling it.
        if (origin === undefined || box.top >= (shown.defaultView?.innerHeight ?? Infinity))
          return earlier;
        if (!origin.literal) return origin.line;
        const starts = lineStarts(text.data);
        const showing = starts.findIndex((start, index) => {
          const end = index + 1 < starts.length ? starts[index + 1]! - 1 : text.length;
          return boxOf(text, start, Math.max(start, end)).bottom > 0;
        });
        return origin.line + Math.max(showing, 0);
      }
      return earlier;
    },
    reveal(line) {
      // A frame the workbench has just put in the page loads and renders again first.
      revealing = line;
      if (shown !== undefined && shown === element.contentDocument) revealShown();
    },
  };
  return frame;
}

/**
 * The page's own ways to leave it turned off on its document, which outlives
 * each `show`: a link's activation (a fragment's scrolls to it), a form's
 * submit and a drop; and the shell's keyboard shortcuts, a chord or a
 * function key, passed to the frame's element, so the workbench's
 * keybindings answer them, but copy, cut and select all, which are the
 * page's.
 */
function guard(doc: Document, element: HTMLIFrameElement): void {
  const stay = (event: Event) => {
    const target = event.target as Element | null;
    // A link drawn by an SVG `use` reaches here as the `use`.
    const link = target?.closest?.("a, area, use");
    if (link === null || link === undefined) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (event.type !== "click" || !href.startsWith("#")) return;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape names the fragment as written.
    }
    (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
  };
  doc.addEventListener("click", stay, true);
  doc.addEventListener("auxclick", stay, true);
  doc.addEventListener("submit", (event) => event.preventDefault(), true);
  doc.addEventListener("dragover", (event) => event.preventDefault(), true);
  doc.addEventListener("drop", (event) => event.preventDefault(), true);
  doc.addEventListener("keydown", (event) => {
    const chord = event.metaKey || event.ctrlKey;
    if (!chord && !/^F\d+$/.test(event.key)) return;
    if (chord && !event.altKey && !event.shiftKey && /^[acx]$/i.test(event.key)) return;
    const forwarded = new KeyboardEvent("keydown", {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      which: event.which,
      location: event.location,
      repeat: event.repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true,
    } as KeyboardEventInit);
    if (!element.dispatchEvent(forwarded)) event.preventDefault();
  });
}
