/** One changed run of a diff: lines `[start, endExclusive)` of each side, one-based, as Monaco's diff editor maps them. */
export interface LineMapping {
  readonly original: { readonly startLineNumber: number; readonly endLineNumberExclusive: number };
  readonly modified: { readonly startLineNumber: number; readonly endLineNumberExclusive: number };
}

/** A row of the diff: a line both sides share, or one only the old or the new side has. */
interface Row {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

/** The excerpt a diff comment quotes, in upstream's shape (`buildDiffReviewComment`, `reviewCommentContext.ts`). */
export interface DiffExcerpt {
  /** The rows' first and last index in the whole diff, context included. */
  readonly startIndex: number;
  readonly endIndex: number;
  /** As upstream labels a range: `12`, `+12 to +15`, `-3`. */
  readonly rangeLabel: string;
  /** A hunk header, then each row with its marker. */
  readonly diff: string;
}

/** Every row of the diff, the files' unchanged lines as context. */
function rows(original: ReadonlyArray<string>, modified: ReadonlyArray<string>, mappings: ReadonlyArray<LineMapping>): Row[] {
  const out: Row[] = [];
  let oldLine = 1;
  let newLine = 1;
  const context = (untilOld: number) => {
    while (oldLine < untilOld && oldLine <= original.length && newLine <= modified.length) {
      out.push({ change: "context", oldLineNumber: oldLine, newLineNumber: newLine, content: modified[newLine - 1] ?? "" });
      oldLine += 1;
      newLine += 1;
    }
  };
  for (const mapping of mappings) {
    context(mapping.original.startLineNumber);
    for (; oldLine < mapping.original.endLineNumberExclusive; oldLine += 1) {
      out.push({ change: "delete", oldLineNumber: oldLine, newLineNumber: null, content: original[oldLine - 1] ?? "" });
    }
    for (newLine = mapping.modified.startLineNumber; newLine < mapping.modified.endLineNumberExclusive; newLine += 1) {
      out.push({ change: "add", oldLineNumber: null, newLineNumber: newLine, content: modified[newLine - 1] ?? "" });
    }
  }
  context(Number.POSITIVE_INFINITY);
  return out;
}

const marker = (change: Row["change"]) => (change === "add" ? "+" : change === "delete" ? "-" : " ");

function label(selected: ReadonlyArray<Row>): string {
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return "line";
  const firstNumber = first.newLineNumber ?? first.oldLineNumber;
  const lastNumber = last.newLineNumber ?? last.oldLineNumber;
  const sign = selected.every((row) => row.change === first.change) ? marker(first.change).trim() : "";
  return firstNumber === lastNumber ? `${sign}${firstNumber}` : `${sign}${firstNumber} to ${sign}${lastNumber}`;
}

function range(selected: ReadonlyArray<Row>, key: "oldLineNumber" | "newLineNumber") {
  const numbered = selected.filter((row) => row[key] !== null);
  return `${numbered[0]?.[key] ?? 0},${numbered.length}`;
}

/**
 * The excerpt of a diff a selection on one side covers: from the first to
 * the last row of that side's selected lines, the other side's rows between
 * them included. `side` is the editor the lines were selected in, the old
 * file's or the new one's; `startLine` and `endLine` are one-based and
 * inclusive. Null when no row is selected.
 */
export function diffExcerpt(input: {
  readonly original: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
  readonly mappings: ReadonlyArray<LineMapping>;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}): DiffExcerpt | null {
  const all = rows(input.original, input.modified, input.mappings);
  const key = input.side === "old" ? "oldLineNumber" : "newLineNumber";
  const inSelection = (row: Row) => row[key] !== null && row[key] >= input.startLine && row[key] <= input.endLine;
  const startIndex = all.findIndex(inSelection);
  const endIndex = all.findLastIndex(inSelection);
  if (startIndex < 0) return null;
  const selected = all.slice(startIndex, endIndex + 1);
  return {
    startIndex,
    endIndex,
    rangeLabel: label(selected),
    diff: [
      `@@ -${range(selected, "oldLineNumber")} +${range(selected, "newLineNumber")} @@`,
      ...selected.map((row) => `${marker(row.change)}${row.content}`),
    ].join("\n"),
  };
}
