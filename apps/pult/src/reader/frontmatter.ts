import type { Element, ElementContent, Text } from "hast";
import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const FENCE = /^(\uFEFF?---[ \t]*(?:\r\n|\n|\r))([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?=\r|\n|$)/m;

const element = (tagName: string, children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

/** Splits a leading YAML mapping from Markdown, preserving the body's source positions. */
export function markdownFrontmatter(source: string) {
  const match = FENCE.exec(source);
  if (match?.index !== 0) return { markdown: source };
  const yamlStart = match[1]!.length;
  const yaml = match[2]!;
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter, intAsBigInt: true });
  if (doc.errors.length !== 0 || !isMap(doc.contents)) return { markdown: source };

  const text = (node: unknown): Text => {
    const range = isNode(node) ? (node.range ?? undefined) : undefined;
    const value = isScalar(node)
      ? String(node.value)
      : range === undefined
        ? "null"
        : yaml.slice(range[0], range[1]);
    if (range === undefined) return { type: "text", value };
    const point = (offset: number) => {
      const { line, col } = lineCounter.linePos(offset);
      return { line: line + 1, column: col, offset: yamlStart + offset };
    };
    return {
      type: "text",
      value,
      position: { start: point(range[0]), end: point(range[1]) },
    };
  };

  const render = (node: unknown): ElementContent[] => {
    if (isMap(node) && node.items.length > 0)
      return [
        element(
          "dl",
          node.items.map(({ key, value }) =>
            element("div", [element("dt", [text(key)]), element("dd", render(value))]),
          ),
        ),
      ];
    if (isSeq(node) && node.items.length > 0)
      return [
        element(
          "ul",
          node.items.map((item) => element("li", render(item))),
        ),
      ];
    return [text(node)];
  };

  const block = element("section", render(doc.contents));
  block.properties = { className: ["pult-reader-frontmatter"], ariaLabel: "Frontmatter" };
  const markdown = match[0].replace(/[^\r\n]/g, " ") + source.slice(match[0].length);
  return { markdown, block, end: match[0].length };
}
