// What a reader's selection cites (`pane.ts`): the selected text as the page
// shows it, and the source lines it came from, read from where each of the
// document's text nodes was made (`render.ts` records it as it builds them).

/**
 * Where a rendered text node came from: the source's text it was made from,
 * which starts on `line`, and whether the node's text is that text as written,
 * line breaks aside, so a part of the node has lines of its own; a node made
 * otherwise (an entity decoded) has its source text's lines whole.
 */
export interface SourceText {
  readonly line: number;
  readonly source: string;
  readonly literal: boolean;
}

/** The selected text, and the one-based, inclusive source lines of the text nodes it touches; none when no text of the source is selected. */
export interface Passage {
  readonly text: string;
  readonly lines: { readonly start: number; readonly end: number } | undefined;
}

const LINE_BREAK = /\r\n?|\n/g;

/** The line of `text`'s character at `index`, `text` starting on `line`. */
const lineAt = (text: string, line: number, index: number) =>
  line + (text.slice(0, index).match(LINE_BREAK)?.length ?? 0);

/** The lines of the non-blank part of `text` from `from` to `to`, `text` starting on `line`; none for blank. */
function linesOf(text: string, line: number, from: number, to: number) {
  const part = text.slice(from, to);
  const first = part.search(/\S/);
  if (first < 0) return undefined;
  const last = part.length - 1 - (part.match(/\s*$/)?.[0].length ?? 0);
  return { start: lineAt(text, line, from + first), end: lineAt(text, line, from + last) };
}

/**
 * The document's selection as a passage: its text with its paragraph breaks,
 * as the browser copies it, and the lines from the first to the last source
 * line of the text it touches. Blank text, a node's untouched end at offset
 * zero among it, and nodes made from no source text address nothing.
 * Undefined when nothing is selected.
 */
export function selectedPassage(
  doc: Document,
  origins: WeakMap<Text, SourceText>,
): Passage | undefined {
  const selection = doc.getSelection();
  if (selection === null || selection.isCollapsed) return undefined;
  const text = selection.toString().replace(/^\n+/, "").trimEnd();
  if (text.trim() === "") return undefined;
  let start = Infinity;
  let end = -Infinity;
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    // The walk's root is the range's common ancestor, a text node itself for a selection within one.
    for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
      const textNode = node as Text;
      const origin = origins.get(textNode);
      if (origin === undefined) continue;
      const from = textNode === range.startContainer ? range.startOffset : 0;
      const to = textNode === range.endContainer ? range.endOffset : textNode.length;
      if (linesOf(textNode.data, 0, from, to) === undefined) continue;
      const lines = origin.literal
        ? linesOf(textNode.data, origin.line, from, to)
        : linesOf(origin.source, origin.line, 0, origin.source.length);
      if (lines === undefined) continue;
      start = Math.min(start, lines.start);
      end = Math.max(end, lines.end);
    }
  }
  return { text, lines: start === Infinity ? undefined : { start, end } };
}
