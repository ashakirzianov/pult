/** A word whose spelling is checked, at `[start, end)` of its line. */
export interface SpellingWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Shorter words are left alone, as cSpell does: too many are abbreviations. */
const MIN_LENGTH = 4;
const INLINE_CODE = /`[^`\n]*`/g;
const RUN = /\S+/g;
const EDGE = /^[^\p{L}]+|[^\p{L}]+$/gu;
const PROSE_RUN = /^[\p{L}\p{M}'’-]+$/u;
/** camelCase's parts, an acronym among them ("HTMLElement" is HTML and Element), an apostrophe kept inside. */
const PART = /\p{Lu}?[\p{Ll}\p{M}]+(?:['’][\p{Ll}\p{M}]+)*|\p{Lu}+(?![\p{Ll}\p{M}])/gu;

/**
 * The words of `line` to check, within its `checkable` ranges (`[start, end)`
 * offsets): each whitespace-separated run, its edge punctuation trimmed, that
 * is letters, apostrophes and hyphens alone, so a path, a URL, an identifier
 * with an underscore or a digit, or inline code in backticks is skipped whole;
 * split at its hyphens and camelCase, and of those parts the ones of four
 * letters or more that are not all capitals.
 */
export function spellingWords(
  line: string,
  checkable: readonly (readonly [number, number])[],
): SpellingWord[] {
  const masked = Array.from({ length: line.length }, () => " ");
  for (const [start, end] of checkable) {
    for (let index = start; index < end; index++) masked[index] = line[index]!;
  }
  const text = masked.join("").replace(INLINE_CODE, (code) => " ".repeat(code.length));
  const words: SpellingWord[] = [];
  for (const run of text.matchAll(RUN)) {
    const trimmed = run[0].replace(EDGE, "");
    if (trimmed === "" || !PROSE_RUN.test(trimmed)) continue;
    const offset = run.index + run[0].search(/\p{L}/u);
    for (const part of trimmed.matchAll(PART)) {
      const word = part[0];
      if (word.length < MIN_LENGTH || word === word.toUpperCase()) continue;
      const start = offset + part.index;
      words.push({ word, start, end: start + word.length });
    }
  }
  return words;
}
