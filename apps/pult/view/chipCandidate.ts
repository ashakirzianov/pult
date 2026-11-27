// The rule that names a file in an inline code span, the thread view's and the reader's in Pult's
// shell: upstream's (`inlineCodeFilePathCandidate`), else a bare name with an extension, any
// `.<something>` (`design.md`, `some-task.task`), which the click resolves (`pult/decisions`,
// `thread-file-links`). Set on the view through `apps/web`'s hook point (`markdown-links.ts`).
import {
  inlineCodeFilePathCandidate,
  resolveMarkdownFileLink,
} from "@t3tools/shared/markdownLinks";

/** Upstream's `FILE_EXTENSION_PATTERN`. */
const EXTENSION = /\.[A-Za-z0-9_-]+$/;

export function chipCandidate(code: string): string | null {
  const trimmed = code.trim();
  const bare =
    !/[\s/\\`]/.test(trimmed) &&
    EXTENSION.test(trimmed) &&
    // The thread view draws a candidate through upstream's link parser, which refuses some (`.env`), so the reader does too.
    resolveMarkdownFileLink(trimmed, "/", "/") !== null;
  return inlineCodeFilePathCandidate(code) ?? (bare ? trimmed : null);
}
