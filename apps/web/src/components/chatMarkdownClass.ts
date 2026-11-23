// Pult: the chat's Markdown classes and list gutter, here so the shell's Markdown reader
// (`apps/pult/src/reader/markdown.ts`) draws its prose with the same ones.
export const CHAT_MARKDOWN_CLASS =
  "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]";
/** A block of chat Markdown's text: its size, line height and colour. */
export const CHAT_MARKDOWN_PROSE_CLASS =
  "text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]";
/** A fenced code block's box. */
export const CHAT_MARKDOWN_CODE_BLOCK_CLASS =
  "chat-markdown-codeblock my-[0.65rem] text-start overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32";

/** An ordered list's gutter, wide enough for its longest marker; none for one-digit markers. */
export function orderedListGutterStyle(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  let number = Number.isNaN(parsedStart) ? 1 : parsedStart;
  let markerWidth = String(number).length;
  for (const value of itemValues) {
    const written = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isNaN(written)) number = written;
    markerWidth = Math.max(markerWidth, String(number).length);
    number += 1;
  }
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}
