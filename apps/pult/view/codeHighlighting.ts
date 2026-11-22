// The thread view's code highlighter, for the reader (`src/reader/markdown.ts`),
// which colours a Markdown file's fenced code as the chat colours its own:
// one shared highlighter, its themes and its languages.
import { highlighterLanguageOf } from "~/components/chat/MarkdownCodeBlock.logic";
import { DIFF_THEME_NAMES } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

/** One coloured run of a line of code. */
export interface CodeToken {
  readonly content: string;
  /** None for the theme's foreground, which the reader's own stands in for. */
  readonly color: string | undefined;
  /** The theme's font style bits: 1 italic, 2 bold, 4 underline. */
  readonly fontStyle: number | undefined;
}

/** `code`'s lines as coloured runs in the scheme's theme, as the chat colours a fence of `language`; none when nothing is coloured, as in a language the highlighter lacks. */
export async function highlightCode(
  code: string,
  language: string,
  scheme: "light" | "dark",
): Promise<CodeToken[][] | undefined> {
  const lang = highlighterLanguageOf(language);
  // The chat renders an `ansi` block's escapes as colours, so the text shown would not be the file's.
  if (lang === "ansi") return undefined;
  const highlighter = await getSyntaxHighlighterPromise(lang);
  // For a language it lacks, the highlighter is plain text's, which colours everything the theme's foreground.
  const { tokens, fg } = highlighter.codeToTokens(code, { lang, theme: DIFF_THEME_NAMES[scheme] });
  const lines = tokens.map((line) =>
    line.map(({ content, color, fontStyle }) => ({
      content,
      color: color?.toLowerCase() === fg?.toLowerCase() ? undefined : color,
      fontStyle: fontStyle || undefined,
    })),
  );
  return lines.some((line) => line.some((token) => token.color ?? token.fontStyle))
    ? lines
    : undefined;
}
