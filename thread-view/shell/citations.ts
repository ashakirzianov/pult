// The shell's citations of files into a composer (`src/composer/cite.ts`):
// upstream's file comments, the draft context records its agent and its
// timeline already read (`reviewCommentContext.ts`).
import { requestReviewCommentFocus } from "../t3/src/components/chat/ComposerCitationBlock";
import { nextFileCommentId } from "../t3/src/components/files/fileCommentAnnotations";
import { useComposerDraftStore } from "../t3/src/composerDraftStore";
import { reviewCommentContextReference } from "../t3/src/lib/composerContextRecords";
import { formatInlineContextReference } from "../t3/src/lib/composerContextReferences";
import { buildFileReviewComment } from "../t3/src/reviewCommentContext";
import { type ComposerTarget, composerKey } from "./drafts.ts";

/** A file's lines to cite: its path as the agent should read it, the lines, one-based and inclusive, and the file's text. */
export interface FileLines {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contents: string;
}

/**
 * Adds the lines to the composer as a file comment with no comment yet, its
 * block (`ComposerCitationBlock.tsx`) on a line of its own at the message's
 * end, since the composer's caret means nothing from a file, and taking
 * focus in the composer in sight; false when the composer is not there to
 * take it.
 */
export function citeFileLines(target: ComposerTarget, lines: FileLines): boolean {
  const key = composerKey(target);
  if (key === null) return false;
  const comment = buildFileReviewComment({
    id: nextFileCommentId(),
    filePath: lines.path,
    startLine: lines.startLine,
    endLine: lines.endLine,
    text: "",
    contents: lines.contents,
  });
  const store = useComposerDraftStore.getState();
  const prompt = (store.getComposerDraft(key)?.prompt ?? "").trimEnd();
  requestReviewCommentFocus(comment.id);
  store.addReviewComment(key, comment, { appendReference: false });
  const reference = formatInlineContextReference(reviewCommentContextReference(comment));
  store.setPrompt(key, `${prompt}${prompt === "" ? "" : "\n"}${reference}\n`);
  return true;
}
