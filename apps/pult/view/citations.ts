// The shell's citations of files and diffs into a composer (`src/composer/cite.ts`):
// upstream's file and diff comments, the draft context records its agent and its
// timeline already read (`reviewCommentContext.ts`).
import { requestReviewCommentFocus } from "../t3/src/components/chat/ComposerCitationBlock";
import { nextFileCommentId } from "../t3/src/components/files/fileCommentAnnotations";
import { useComposerDraftStore } from "../t3/src/composerDraftStore";
import { reviewCommentContextReference } from "../t3/src/lib/composerContextRecords";
import { formatInlineContextReference } from "../t3/src/lib/composerContextReferences";
import { buildFileReviewComment, type ReviewCommentContext } from "../t3/src/reviewCommentContext";
import { type ComposerTarget, composerKey } from "./drafts.ts";

/** A file's lines to cite: its path as the agent should read it, the lines, one-based and inclusive, and the file's text. */
export interface FileLines {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contents: string;
}

/**
 * Adds the lines to the composer as upstream's file comment with no comment yet, its
 * block (`ComposerCitationBlock.tsx`) on a line of its own at the message's
 * end, since the composer's caret means nothing from a file, and taking
 * focus in the composer in sight; false when the composer is not there to
 * take it.
 */
export function citeFileLines(target: ComposerTarget, lines: FileLines): boolean {
  return cite(
    target,
    buildFileReviewComment({
      id: nextFileCommentId(),
      filePath: lines.path,
      startLine: lines.startLine,
      endLine: lines.endLine,
      text: "",
      contents: lines.contents,
    }),
  );
}

/** A diff's lines to cite: the file's path as the agent should read it, the diff's source as upstream labels it, and the excerpt (`src/composer/diffExcerpt.ts`). */
export interface DiffLines {
  readonly path: string;
  readonly source: "Changes" | "Uncommitted";
  readonly side: "additions" | "deletions";
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly diff: string;
}

/** Adds the lines to the composer as upstream's diff comment, as `citeFileLines` adds a file's. */
export function citeDiffLines(target: ComposerTarget, lines: DiffLines): boolean {
  return cite(target, {
    id: nextFileCommentId(),
    sectionId: `diff:${lines.source}`,
    sectionTitle: lines.source,
    filePath: lines.path,
    startIndex: lines.startIndex,
    endIndex: lines.endIndex,
    rangeLabel: lines.rangeLabel,
    text: "",
    diff: lines.diff,
    fenceLanguage: "diff",
    selection: { start: lines.startLine, side: lines.side, end: lines.endLine, endSide: lines.side },
  });
}

function cite(target: ComposerTarget, comment: ReviewCommentContext): boolean {
  const key = composerKey(target);
  if (key === null) return false;
  const store = useComposerDraftStore.getState();
  const prompt = (store.getComposerDraft(key)?.prompt ?? "").trimEnd();
  requestReviewCommentFocus(comment.id);
  store.addReviewComment(key, comment, { appendReference: false });
  const reference = formatInlineContextReference(reviewCommentContextReference(comment));
  store.setPrompt(key, `${prompt}${prompt === "" ? "" : "\n"}${reference}\n`);
  return true;
}
