// A project's Markdown file as its reader shows it (`render.ts`): CommonMark
// and GFM (tables, task lists, strikethrough, autolinks, footnotes) parsed by
// the remark pipeline `apps/web` ships, with raw HTML in it parsed in place,
// to an HTML tree whose every node keeps where in the file it came from, then
// built by the HTML reader's own rules, so raw HTML runs and loads nothing.
// A fenced block is coloured by its language, as the chat colours it, and
// `$` and `$$` math typeset by KaTeX (`math.ts`), each node of either keeping
// the lines it came from; diagrams are their source as code.
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { toParse5 } from "hast-util-to-parse5";
import {
  defaultTreeAdapter,
  html as parse5,
  parseFragment,
  type DefaultTreeAdapterTypes,
} from "parse5";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  CHAT_MARKDOWN_CLASS,
  CHAT_MARKDOWN_CODE_BLOCK_CLASS,
  CHAT_MARKDOWN_PROSE_CLASS,
  orderedListGutterStyle,
} from "../../view/chatMarkdownClass.ts";
import type { SourceText } from "./selection.ts";

/** Where parse5 found a node in the source. */
export type SourceLocation = NonNullable<DefaultTreeAdapterTypes.TextNode["sourceCodeLocation"]>;

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(() => (tree: Root, file) => placeText(tree, String(file.value)))
  .use(rehypeRaw);

const LINE_BREAK = /\r\n?|\n/g;

/**
 * The tree's text as `build` reads it. The whitespace remark puts between
 * blocks has no place in the file and is left out, since `rehype-raw` would
 * merge it into the text beside it, which then loses its place. The text of
 * code and math, which remark places only by its element, is given its lines:
 * an inline one's the element's, delimiters included; a block's from the
 * line after its fence, or its own line for an indented one, as many as the
 * text has.
 */
function placeText(node: Root | Element, source: string): void {
  const children = node.children as Array<RootContent | ElementContent>;
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (child.type === "text" && child.position === undefined && child.value.trim() === "")
      children.splice(index, 1);
  }
  for (const child of children) {
    if (child.type !== "element") continue;
    const block = child.tagName === "pre" ? child.children[0] : undefined;
    const code = block ?? child;
    const text = code.type === "element" && code.tagName === "code" ? code.children[0] : undefined;
    const position = code.position ?? child.position;
    const offset = position?.start.offset;
    if (
      text?.type !== "text" ||
      text.position !== undefined ||
      position === undefined ||
      offset === undefined
    ) {
      placeText(child, source);
      continue;
    }
    if (block === undefined) {
      text.position = position;
      continue;
    }
    const fenced = /^(?:`{3,}|~{3,}|\${2,})/.test(source.slice(offset));
    const line = position.start.line + (fenced ? 1 : 0);
    const lines = text.value.match(LINE_BREAK)?.length ?? 0;
    // `markdownOrigins` reads lines alone.
    text.position = {
      start: { line, column: 1, offset },
      end: { line: line + lines, column: 1, offset },
    };
  }
}

/** A fenced block's code element, its language and its text, which `placeText` gave its lines. */
interface Fenced {
  readonly code: Element;
  readonly language: string;
  readonly text: Text;
}

/** The code blocks under `node` with a language, but math's, whose text has its lines. */
function fencedCode(node: Root | Element, found: Fenced[] = []): Fenced[] {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const code = child.tagName === "pre" ? child.children[0] : undefined;
    if (code?.type !== "element" || code.tagName !== "code") {
      fencedCode(child, found);
      continue;
    }
    const classes = code.properties.className;
    const language = (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length);
    const [text, ...rest] = code.children;
    if (language === undefined || language === "math" || text?.type !== "text" || rest.length > 0)
      continue;
    if (text.position !== undefined) found.push({ code, language, text });
  }
  return found;
}

/**
 * Each fenced block of `tree` in a language the chat's highlighter knows, in
 * the scheme's colours: a span per coloured run, each its own text node on
 * its line of the file; the line breaks between them, which no citation
 * needs, have none. A block in any other language keeps its one text node.
 */
async function colourCode(tree: Root, scheme: "light" | "dark"): Promise<void> {
  const blocks = fencedCode(tree);
  if (blocks.length === 0) return;
  const { highlightCode } = await import("../../view/codeHighlighting.ts");
  await Promise.all(
    blocks.map(async ({ code, language, text }) => {
      const lines = await highlightCode(text.value, language, scheme);
      if (lines === undefined) return;
      const shown = lines.map((tokens) => tokens.map((token) => token.content).join("")).join("\n");
      if (shown !== text.value.replace(LINE_BREAK, "\n"))
        throw new Error(`The highlighter changed a ${language} block's text`);
      const start = text.position!.start;
      code.children = lines.flatMap((tokens, index): ElementContent[] => {
        const line = start.line + index;
        const runs = tokens.map((token): ElementContent => {
          const run: Text = {
            type: "text",
            value: token.content,
            position: { start: { ...start, line }, end: { ...start, line } },
          };
          const style = [
            token.color === undefined ? "" : `color: ${token.color};`,
            (token.fontStyle ?? 0) & 1 ? "font-style: italic;" : "",
            (token.fontStyle ?? 0) & 2 ? "font-weight: bold;" : "",
            (token.fontStyle ?? 0) & 4 ? "text-decoration: underline;" : "",
          ].join("");
          return style === ""
            ? run
            : { type: "element", tagName: "span", properties: { style }, children: [run] };
        });
        return index === 0 ? runs : [{ type: "text", value: "\n" }, ...runs];
      });
    }),
  );
}

/** A formula's element in its parent: inline code, or a display's `pre`, and its TeX's text node. */
interface Formula {
  readonly parent: DefaultTreeAdapterTypes.ParentNode;
  readonly element: DefaultTreeAdapterTypes.Element;
  readonly display: boolean;
  readonly text: DefaultTreeAdapterTypes.TextNode;
}

/** The formulas under `parent`, as remark-math leaves them: `code.math-inline` and `pre > code.math-display`. */
function formulas(parent: DefaultTreeAdapterTypes.ParentNode, found: Formula[] = []): Formula[] {
  for (const node of parent.childNodes) {
    if (!("tagName" in node)) continue;
    const code = node.tagName === "pre" ? node.childNodes[0] : node;
    const classes =
      code !== undefined && "tagName" in code && code.tagName === "code"
        ? (code.attrs.find((attr) => attr.name === "class")?.value.split(/\s+/) ?? [])
        : [];
    const display = node !== code && classes.includes("math-display");
    const [text, ...rest] = code !== undefined && "childNodes" in code ? code.childNodes : [];
    if (
      (display || classes.includes("math-inline")) &&
      text?.nodeName === "#text" &&
      rest.length === 0
    )
      found.push({
        parent,
        element: node,
        display,
        text: text as DefaultTreeAdapterTypes.TextNode,
      });
    else formulas(node, found);
  }
  return found;
}

/** Every text node under `parent`. */
function* textNodes(
  parent: DefaultTreeAdapterTypes.ParentNode,
): Generator<DefaultTreeAdapterTypes.TextNode> {
  for (const node of parent.childNodes) {
    if (node.nodeName === "#text") yield node as DefaultTreeAdapterTypes.TextNode;
    else if ("childNodes" in node) yield* textNodes(node);
  }
}

/**
 * Each formula of `doc` typeset in place, a display's in a block of its own,
 * every text node of its markup placed where its TeX was, so a citation of
 * any part of it is the formula's lines; one KaTeX refuses stays its source
 * as code. KaTeX's styles when any was typeset, which the document then needs.
 */
async function typesetMath(doc: DefaultTreeAdapterTypes.Document): Promise<string | undefined> {
  const found = formulas(doc);
  if (found.length === 0) return undefined;
  const { MATH_STYLE, typeset } = await import("./math.ts");
  let typesetAny = false;
  for (const { parent, element, display, text } of found) {
    const markup = typeset(text.value, display);
    if (markup === undefined) continue;
    const fragment = parseFragment(display ? `<div class="math-display">${markup}</div>` : markup);
    for (const node of textNodes(fragment)) node.sourceCodeLocation = text.sourceCodeLocation;
    for (const node of fragment.childNodes) node.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(element), 1, ...fragment.childNodes);
    typesetAny = true;
  }
  return typesetAny ? MATH_STYLE : undefined;
}

/** The workbench's colours and fonts the thread view's and the reader's styles read, copied into the frame, which inherits none. */
const THEME = [
  "--vscode-editor-background",
  "--vscode-editor-foreground",
  "--vscode-scrollbarSlider-background",
  "--vscode-scrollbarSlider-hoverBackground",
  "--vscode-scrollbarSlider-activeBackground",
];

/**
 * What the reader adds to the thread view's stylesheets: the body, which
 * takes the thread view's root class for their rules, is a page that scrolls
 * rather than a pane that clips; a wide table or formula scrolls in its own
 * box; the document's scrollbars, which the view's scope does not reach.
 */
const STYLE = `
html { background: var(--vscode-editor-background); }
body.pult-thread-view { display: block; width: auto; height: auto; min-height: 100%; margin: 0; padding-block: 1rem 2rem; overflow: visible; }
.chat-markdown-table-container { overflow-x: auto; }
.math-display { margin: 0.65rem 0; overflow-x: auto; overflow-y: hidden; }
.math-display > .katex-display { margin: 0; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
`;

/** Each page stylesheet's text, read once: `""` for one that styles no chat Markdown. */
const sheetTexts = new WeakMap<CSSStyleSheet, string>();

/**
 * The thread view's stylesheets as text, so the reader's prose is drawn by
 * the very rules the thread's is, its fonts left out, since the frame loads
 * none. The view is loaded before a Markdown file renders (`pane.ts`).
 */
function viewStyles(page: Document): string {
  const texts = [...page.styleSheets].map((sheet) => {
    const known = sheetTexts.get(sheet);
    if (known !== undefined) return known;
    if (sheet.href !== null && new URL(sheet.href).origin !== page.location.origin) return "";
    const rules = [...sheet.cssRules].filter((rule) => !(rule instanceof CSSFontFaceRule));
    const text = rules.map((rule) => rule.cssText).join("\n");
    const styles = text.includes(".chat-markdown") ? text : "";
    sheetTexts.set(sheet, styles);
    return styles;
  });
  const styles = texts.filter((text) => text !== "").join("\n");
  if (styles === "") throw new Error("the thread view's stylesheet is not on the page");
  return styles;
}

/** Whether `pre` holds a display formula, which KaTeX replaces (`typesetMath`), so it is no code block. */
const holdsMath = (pre: Element) => {
  const [code] = pre.children;
  const classes = code?.type === "element" ? code.properties.className : undefined;
  return Array.isArray(classes) && classes.includes("math-display");
};

/**
 * The thread's own markup for its blocks under `node`: the box around each
 * `table`, which scrolls it, and each `pre`, its surface, wrapping its lines
 * by the chat's setting (`wrapCode`), and an ordered list's marker gutter.
 */
function boxBlocks(node: Root | Element, wrapCode: boolean): void {
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child;
    if (child.tagName === "ol") {
      const values = child.children.flatMap((item) =>
        item.type === "element" && item.tagName === "li" ? [item.properties.value] : [],
      );
      const gutter = orderedListGutterStyle(values, child.properties.start);
      if (gutter !== undefined) {
        const authored = typeof child.properties.style === "string" ? child.properties.style : "";
        child.properties.style = `${authored}${authored ? ";" : ""}--list-gutter:${gutter["--list-gutter"]}`;
      }
    }
    if (child.tagName !== "table" && (child.tagName !== "pre" || holdsMath(child))) {
      boxBlocks(child, wrapCode);
      return child;
    }
    const properties =
      child.tagName === "table"
        ? { className: ["chat-markdown-table-container"] }
        : {
            className: CHAT_MARKDOWN_CODE_BLOCK_CLASS.split(" "),
            dataWrap: wrapCode ? "true" : "false",
          };
    return { type: "element", tagName: "div", properties, children: [child] };
  }) as typeof node.children;
}

/**
 * The reader's Markdown document, drawn as the thread draws its messages: the
 * thread view's stylesheets, its theme and text scale, and its column and
 * prose classes around the rendered file, each node with where in `source`
 * it came from. `themed` inherits the workbench's colours; `wrapCode` is the
 * chat's line wrap for code.
 */
export async function markdownTree(
  source: string,
  themed: globalThis.Element,
  wrapCode: boolean,
): Promise<DefaultTreeAdapterTypes.Document> {
  const computed = getComputedStyle(themed);
  const theme = THEME.map((name) => [name, computed.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  const page = themed.ownerDocument;
  const pageRoot = page.documentElement;
  // The frame's own element is `color-scheme: normal`, for a page's sake; the shell's root follows the workbench theme.
  const { colorScheme: scheme, fontSize } = getComputedStyle(pageRoot);
  const style = (text: string): Element => ({
    type: "element",
    tagName: "style",
    properties: {},
    children: [{ type: "text", value: text }],
  });
  const head: Element = {
    type: "element",
    tagName: "head",
    properties: {},
    children: [
      style(viewStyles(page)),
      // The thread view inherits its sans font from the workbench, as the frame's element does.
      style(
        `:root { ${theme} color-scheme: ${scheme}; font-size: ${fontSize}; font-family: ${computed.fontFamily}; }${STYLE}`,
      ),
    ],
  };
  const body = processor.runSync(processor.parse(source), source);
  await colourCode(body, scheme.includes("dark") ? "dark" : "light");
  boxBlocks(body, wrapCode);
  const themeId = pageRoot.getAttribute("data-theme-id");
  const html: Element = {
    type: "element",
    tagName: "html",
    properties: {
      // The view's dark variants and theme rules read these on the document's root; its appearance tokens are inline there.
      className: [...pageRoot.classList],
      ...(themeId === null ? {} : { dataThemeId: themeId }),
      style: pageRoot.style.cssText,
    },
    children: [
      head,
      {
        type: "element",
        tagName: "body",
        // The thread view's root, and the side gutters its timeline and composer share.
        properties: { className: ["pult-thread-view", "chat-composer-lane"] },
        children: [
          {
            type: "element",
            tagName: "div",
            properties: { className: ["chat-content-lane"] },
            children: [
              {
                // An assistant row's own box in the timeline (`TimelineAssistantRows.tsx`).
                type: "element",
                tagName: "div",
                properties: { className: ["min-w-0", "px-1", "py-0.5"] },
                children: [
                  {
                    type: "element",
                    tagName: "div",
                    properties: {
                      className: `${CHAT_MARKDOWN_CLASS} ${CHAT_MARKDOWN_PROSE_CLASS}`.split(" "),
                    },
                    children: body.children as ElementContent[],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const doc = toParse5({ type: "root", children: [html] }) as DefaultTreeAdapterTypes.Document;
  const math = await typesetMath(doc);
  if (math !== undefined) {
    const [root] = doc.childNodes as DefaultTreeAdapterTypes.Element[];
    const [parsedHead] = root!.childNodes as DefaultTreeAdapterTypes.Element[];
    const sheet = defaultTreeAdapter.createElement("style", parse5.NS.HTML, []);
    defaultTreeAdapter.insertText(sheet, math);
    defaultTreeAdapter.appendChild(parsedHead!, sheet);
  }
  return doc;
}

/**
 * Where each Markdown text node of `source` came from, read by its lines
 * alone: `rehype-raw` puts raw HTML's nodes on their lines, but at offsets
 * into the HTML with a container's markers (`> `, an indent) taken out. A
 * node is literal while its line breaks are the lines it spans, so a part of
 * it has lines of its own; its source text is its lines whole, but a last
 * one it ends at the start of.
 */
export function markdownOrigins(source: string) {
  const lines = source.split(LINE_BREAK);
  return (at: SourceLocation, value: string): SourceText => {
    const last = at.endCol === 1 && at.endLine > at.startLine ? at.endLine - 1 : at.endLine;
    return {
      line: at.startLine,
      source: lines.slice(at.startLine - 1, last).join("\n"),
      literal: (value.match(LINE_BREAK)?.length ?? 0) === at.endLine - at.startLine,
    };
  };
}
