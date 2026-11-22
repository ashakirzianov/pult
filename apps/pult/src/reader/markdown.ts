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

/** The workbench's colours and fonts the reader's styles read, copied into the frame, which inherits none. */
const THEME = [
  "--vscode-editor-background",
  "--vscode-editor-foreground",
  "--vscode-font-family",
  "--vscode-editor-font-family",
  "--vscode-textLink-foreground",
  "--vscode-textLink-activeForeground",
  "--vscode-textCodeBlock-background",
  "--vscode-textBlockQuote-background",
  "--vscode-textBlockQuote-border",
  "--vscode-textSeparator-foreground",
  "--vscode-editorGroup-border",
  "--vscode-scrollbarSlider-background",
  "--vscode-scrollbarSlider-hoverBackground",
  "--vscode-scrollbarSlider-activeBackground",
];

/** The reader's look for a Markdown file, after the stock preview's, in the workbench's colours. */
const STYLE = `
body {
  margin: 0 auto;
  padding: 0 26px 26px;
  max-width: 882px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.6;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  overflow-wrap: break-word;
}
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 24px 0 16px; }
h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
h5 { font-size: 0.875em; }
h6 { font-size: 0.85em; }
h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-textSeparator-foreground, #8884); }
p, ul, ol, blockquote, pre, table { margin: 0 0 16px; }
ul, ol { padding-left: 2em; }
li > p { margin-bottom: 0; }
li + li { margin-top: 0.25em; }
li:has(> input[type="checkbox"]) { list-style: none; }
li > input[type="checkbox"] { margin: 0 0.3em 0.2em -1.4em; vertical-align: middle; }
a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
a:hover { color: var(--vscode-textLink-activeForeground, #3794ff); text-decoration: underline; }
code { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 0.9em; }
:not(pre) > code {
  padding: 0.1em 0.3em;
  border-radius: 3px;
  background: var(--vscode-textCodeBlock-background, #8882);
}
pre {
  padding: 16px;
  border-radius: 3px;
  overflow: auto;
  line-height: 1.45;
  background: var(--vscode-textCodeBlock-background, #8882);
}
pre code { font-size: 0.9em; tab-size: 4; }
blockquote {
  margin-left: 0;
  padding: 2px 16px 2px 10px;
  border-left: 5px solid var(--vscode-textBlockQuote-border, #8888);
  border-radius: 2px;
  background: var(--vscode-textBlockQuote-background, transparent);
}
blockquote > :last-child { margin-bottom: 0; }
table { border-collapse: collapse; display: block; overflow: auto; }
th { text-align: left; }
th, td { padding: 5px 10px; border: 1px solid var(--vscode-editorGroup-border, #8884); }
hr { height: 1px; margin: 24px 0; border: 0; background: var(--vscode-textSeparator-foreground, #8884); }
img { max-width: 100%; }
.math-display { margin: 0 0 16px; overflow-x: auto; overflow-y: hidden; }
.math-display > .katex-display { margin: 0; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
`;

/**
 * The reader's Markdown document: its styles, with the workbench's colours
 * and colour scheme as `themed` inherits them, and the rendered file as its
 * body, each node with where in `source` it came from.
 */
export async function markdownTree(
  source: string,
  themed: globalThis.Element,
): Promise<DefaultTreeAdapterTypes.Document> {
  const computed = getComputedStyle(themed);
  const theme = THEME.map((name) => [name, computed.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
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
    children: [style(`:root { ${theme} }${STYLE}`)],
  };
  const body = processor.runSync(processor.parse(source), source);
  // The frame's own element is `color-scheme: normal`, for a page's sake; the shell's root follows the workbench theme.
  const scheme = getComputedStyle(themed.ownerDocument.documentElement).colorScheme;
  await colourCode(body, scheme.includes("dark") ? "dark" : "light");
  const html: Element = {
    type: "element",
    tagName: "html",
    properties: {},
    children: [
      head,
      {
        type: "element",
        tagName: "body",
        properties: {},
        children: body.children as ElementContent[],
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
