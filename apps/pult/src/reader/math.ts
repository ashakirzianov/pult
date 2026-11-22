// Math in the reader's Markdown (`markdown.ts`), loaded with the first
// document that has any: KaTeX's markup for a `$` or `$$` formula, typeset as
// the chat typesets it (`apps/web`'s `MathTypeset.tsx`), and KaTeX's
// stylesheet with its fonts as `data:` URLs, the only fonts the frame loads.
import katex from "katex";
import css from "katex/dist/katex.min.css?raw";

const FONTS = import.meta.glob<string>("../../node_modules/katex/dist/fonts/*.woff2", {
  query: "?inline",
  import: "default",
  eager: true,
});

const fontUrls = new Map(
  Object.entries(FONTS).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
);

/** KaTeX's stylesheet, each font its WOFF2 alone, inlined. */
export const MATH_STYLE = css.replace(
  /src:url\(fonts\/([\w-]+\.woff2)\)[^;}]*/g,
  (_, name: string) => {
    const url = fontUrls.get(name);
    if (url === undefined)
      throw new Error(`KaTeX's stylesheet names a font it does not ship: ${name}`);
    return `src:url(${url}) format("woff2")`;
  },
);

/** The formula's markup, or none when KaTeX refuses it, so it shows as its source. */
export function typeset(tex: string, display: boolean): string | undefined {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      // No \href, \url, \htmlClass, or other commands that emit active HTML.
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    return undefined;
  }
}
