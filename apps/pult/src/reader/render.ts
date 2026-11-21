// A project's HTML file as its reader shows it (`src/reader/pane.ts`): the
// page with its own CSS and inline images, in a frame of its own, with no
// script run and nothing fetched or navigated to. The buffer is parsed here,
// in JavaScript, and the frame's document built node by node from the tree,
// so the browser never parses the page's markup nor sees a URL of it.
import { parse, type DefaultTreeAdapterTypes } from "parse5";

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
}

function build(doc: Document, parent: ParentNode, nodes: readonly Node[], built: Built): void {
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      parent.append(doc.createTextNode((node as DefaultTreeAdapterTypes.TextNode).value));
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
  /** Renders `source`, at the reader's scroll position or, `fresh`, at the top; whether the page has scripts, which never run here. */
  show(
    source: string,
    options?: { readonly fresh?: boolean },
  ): Promise<{ readonly scripts: boolean }>;
}

/**
 * A frame for a page, to be attached before its first `show`: sandboxed with
 * no script allowed and the shell's origin, so the shell reads and builds its
 * document; its policy refuses every request but `data:` URLs; a link's
 * click, a form's submit and a drop never navigate it, and a link to a
 * fragment of the page scrolls to it.
 */
export function createReaderFrame(): ReaderFrame {
  const element = document.createElement("iframe");
  element.className = "pult-reader-frame";
  element.setAttribute("sandbox", "allow-same-origin");
  element.setAttribute("referrerpolicy", "no-referrer");
  element.setAttribute("allow", "");
  let current: Document | undefined;
  let loading: Array<(doc: Document) => void> = [];
  let latest = 0;
  let last: string | undefined;
  // Where the reader is in the page, kept across the document's reloads.
  let position = { top: 0, left: 0 };
  let shown: Document | undefined;

  // Each load of the frame's document is guarded and followed for the
  // reader's place: its first, and any the browser makes again, as for a
  // frame taken out of the page and put back (the workbench detaches a
  // hidden pane), which shows the page again where the reader was.
  element.addEventListener("load", () => {
    const doc = element.contentDocument;
    if (doc === null || !doc.URL.startsWith("about:srcdoc")) return;
    guard(doc, element);
    doc.addEventListener("scroll", () => {
      const scroller = doc.scrollingElement;
      if (scroller !== null) position = { top: scroller.scrollTop, left: scroller.scrollLeft };
    });
    current = doc;
    const waiting = loading;
    loading = [];
    for (const resolve of waiting) resolve(doc);
    if (waiting.length === 0 && last !== undefined) void frame.show(last);
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
      last = source;
      const tree = parse(source, { scriptingEnabled: false });
      const doc = await frameDocument();
      const built: Built = { scripts: false };
      const html = tree.childNodes.find((node) => "tagName" in node && node.tagName === "html");
      if (revision !== latest || html === undefined || !("tagName" in html)) return built;
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
      return built;
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
