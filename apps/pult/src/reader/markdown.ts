// A project's Markdown file as its reader shows it (`render.ts`): CommonMark
// and GFM (tables, task lists, strikethrough, autolinks, footnotes) parsed by
// the remark pipeline `apps/web` ships, with raw HTML in it parsed in place,
// to an HTML tree whose every node keeps where in the file it came from, then
// built by the HTML reader's own rules, so raw HTML runs and loads nothing.
// Diagrams and math are their source as code: a fenced block, `$` and `$$`.
import type { Element, ElementContent, Root, RootContent } from "hast";
import { toParse5 } from "hast-util-to-parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(() => (tree: Root, file) => placeCode(tree, String(file.value)))
  .use(rehypeRaw);

const LINE_BREAK = /\r\n?|\n/g;

/** The offset in `source` past `count` line breaks from `from`, or its end. */
function pastLines(source: string, from: number, count: number): number {
  LINE_BREAK.lastIndex = from;
  let at = from;
  for (let index = 0; index < count; index++) {
    const found = LINE_BREAK.exec(source);
    if (found === null) return source.length;
    at = found.index + found[0].length;
  }
  return at;
}

/**
 * The text of code and math where it is in the file, which remark gives only
 * its element: an inline one's text the element's place, delimiters
 * included; a block's from the line after its fence, or its own line for an
 * indented one, through as many lines as the text has.
 */
function placeCode(node: Root | Element, source: string): void {
  for (const child of node.children as Array<RootContent | ElementContent>) {
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
      placeCode(child, source);
      continue;
    }
    if (block === undefined) {
      text.position = position;
      continue;
    }
    const fenced = /^(?:`{3,}|~{3,}|\${2,})/.test(source.slice(offset));
    const start = fenced ? pastLines(source, offset, 1) : offset;
    const lines = text.value.match(LINE_BREAK)?.length ?? 0;
    const end = pastLines(source, start, lines);
    const line = position.start.line + (fenced ? 1 : 0);
    text.position = {
      start: { line, column: 1, offset: start },
      end: { line: line + lines, column: 1, offset: end },
    };
  }
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
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
`;

/**
 * The reader's Markdown document: its styles, with the workbench's colours
 * as `themed` inherits them, and the rendered file as its body, each node
 * with where in `source` it came from.
 */
export function markdownTree(
  source: string,
  themed: globalThis.Element,
): DefaultTreeAdapterTypes.Document {
  const computed = getComputedStyle(themed);
  const theme = THEME.map((name) => [name, computed.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  const style: Element = {
    type: "element",
    tagName: "style",
    properties: {},
    children: [{ type: "text", value: `:root { ${theme} }${STYLE}` }],
  };
  const head: Element = { type: "element", tagName: "head", properties: {}, children: [style] };
  const body = processor.runSync(processor.parse(source), source);
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
  return toParse5({ type: "root", children: [html] }) as DefaultTreeAdapterTypes.Document;
}

/** A Markdown text node's text is as written when its line breaks are its source's, each line then its own. */
export const markdownLiteral = (source: string, value: string) =>
  (source.match(LINE_BREAK)?.length ?? 0) === (value.match(LINE_BREAK)?.length ?? 0);
