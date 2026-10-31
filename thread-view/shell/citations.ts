// The shell's citations of files into a composer (`src/composer/cite.ts`):
// upstream's file comments, the draft context records its agent and its
// timeline already read (`reviewCommentContext.ts`).
import { nextFileCommentId } from "../t3/src/components/files/fileCommentAnnotations";
import { useComposerDraftStore } from "../t3/src/composerDraftStore";
import { buildFileReviewComment } from "../t3/src/reviewCommentContext";
import { type ComposerTarget, composerKey } from "./drafts.ts";

/** A file's lines to cite: its path as the agent should read it, the lines, one-based and inclusive, and the file's text. */
export interface FileLines {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contents: string;
}

/** Adds the lines to the composer as a file comment with no comment yet; false when the composer is not there to take it. */
export function citeFileLines(target: ComposerTarget, lines: FileLines): boolean {
  const key = composerKey(target);
  if (key === null) return false;
  useComposerDraftStore.getState().addReviewComment(
    key,
    buildFileReviewComment({
      id: nextFileCommentId(),
      filePath: lines.path,
      startLine: lines.startLine,
      endLine: lines.endLine,
      text: "",
      contents: lines.contents,
    }),
  );
  return true;
}
