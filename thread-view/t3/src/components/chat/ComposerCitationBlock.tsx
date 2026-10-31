import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { ComposerContextActionsContext } from "../composerContextPresentation";

// Pult's composer citation: a block on its own line, the quote and then the
// user's comment, edited in place. An assistant citation keeps its comment as
// its node's attribute; a file or diff comment (upstream's review comment, a
// context reference node) keeps it as its record's text in the draft. Either
// way the comment is not document content, so the field is the node view's
// own textarea; the editor enters it by key (`enterComposerCitationByKey`)
// and the field leaves it by key. A comment left empty when the field loses
// focus removes the citation.

const CITATION_NODE = "composer-citation";
const CONTEXT_REFERENCE_NODE = "composer-context-reference";
const COMMENT_INPUT_SELECTOR = "textarea[data-citation-comment-input]";

type Edge = "start" | "end";

/** A node drawn as a block: an assistant citation, or a file or diff comment's reference. */
function isCitation(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return (
    node?.type.name === CITATION_NODE ||
    (node?.type.name === CONTEXT_REFERENCE_NODE && node.attrs.kind === "review-comment")
  );
}

function focusCitationComment(view: EditorView, pos: number, edge: Edge): boolean {
  const dom = view.nodeDOM(pos);
  const input = dom instanceof HTMLElement ? dom.querySelector(COMMENT_INPUT_SELECTOR) : null;
  if (!(input instanceof HTMLTextAreaElement)) return false;
  input.focus({ preventScroll: true });
  const offset = edge === "start" ? 0 : input.value.length;
  input.setSelectionRange(offset, offset);
  input.scrollIntoView({ block: "nearest" });
  return true;
}

/**
 * The citation the caret at `$pos` would delete or step into going backward,
 * and its position; `lineAbove` takes the previous line's from anywhere on
 * this one.
 */
function citationBehind(view: EditorView, $pos: ResolvedPos, lineAbove = false): number | null {
  const before = $pos.nodeBefore;
  if (isCitation(before)) return $pos.pos - before.nodeSize;
  if ($pos.depth !== 1 || (!lineAbove && $pos.parentOffset !== 0) || $pos.index(0) === 0) {
    return null;
  }
  const previous = view.state.doc.child($pos.index(0) - 1);
  const last = previous.lastChild;
  if (previous.type.name !== "paragraph" || !isCitation(last)) return null;
  return $pos.before(1) - 1 - last.nodeSize;
}

/**
 * The citation the caret at `$pos` would delete or step into going forward,
 * and its position; `lineBelow` takes the next line's from anywhere on this
 * one.
 */
function citationAhead(view: EditorView, $pos: ResolvedPos, lineBelow = false): number | null {
  if (isCitation($pos.nodeAfter)) return $pos.pos;
  const { doc } = view.state;
  if (
    $pos.depth !== 1 ||
    (!lineBelow && $pos.parentOffset !== $pos.parent.content.size) ||
    $pos.index(0) >= doc.childCount - 1
  ) {
    return null;
  }
  const next = doc.child($pos.index(0) + 1);
  if (next.type.name !== "paragraph" || !isCitation(next.firstChild)) return null;
  return $pos.after(1) + 1;
}

/**
 * The editor's side of the block's keys. Backspace and Left (or Up from the
 * line below) into a block enter its comment at the end, Delete and Right (or
 * Down from the line above) at the start. With Shift, and Option or not, the
 * same keys extend the selection over the block alone, Option+Up and
 * Option+Down off a line's edge left to the platform. Returns whether it
 * handled the key.
 */
export function enterComposerCitationByKey(view: EditorView, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.isComposing) return false;
  if (event.shiftKey) return extendOverCitation(view, event);
  if (event.altKey || !view.state.selection.empty) return false;
  const { $from } = view.state.selection;
  const target =
    event.key === "Backspace" || event.key === "ArrowLeft"
      ? { pos: citationBehind(view, $from), edge: "end" as const }
      : event.key === "ArrowUp" && view.endOfTextblock("up")
        ? { pos: citationBehind(view, $from, true), edge: "end" as const }
        : event.key === "Delete" || event.key === "ArrowRight"
          ? { pos: citationAhead(view, $from), edge: "start" as const }
          : event.key === "ArrowDown" && view.endOfTextblock("down")
            ? { pos: citationAhead(view, $from, true), edge: "start" as const }
            : null;
  if (target?.pos == null || !focusCitationComment(view, target.pos, target.edge)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

/** Whether the selection's head is on its line's first or last visual row; the editor's own check reads the selection's start or end. */
function headOnEdgeLine(view: EditorView, dir: "up" | "down"): boolean {
  const { state } = view;
  const collapsed = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.selection.head)));
  return view.endOfTextblock(dir, collapsed);
}

function extendOverCitation(view: EditorView, event: KeyboardEvent): boolean {
  const { selection, doc } = view.state;
  const { $head } = selection;
  // Option+Up and Option+Down first go to the line's start or end.
  const atLineStart = !event.altKey || $head.parentOffset === 0;
  const atLineEnd = !event.altKey || $head.parentOffset === $head.parent.content.size;
  let head: number | null = null;
  if (event.key === "ArrowLeft") {
    head = citationBehind(view, $head);
  } else if (event.key === "ArrowUp" && atLineStart && headOnEdgeLine(view, "up")) {
    head = citationBehind(view, $head, true);
  } else if (
    event.key === "ArrowRight" ||
    (event.key === "ArrowDown" && atLineEnd && headOnEdgeLine(view, "down"))
  ) {
    const pos = citationAhead(view, $head, event.key === "ArrowDown");
    head = pos === null ? null : pos + doc.nodeAt(pos)!.nodeSize;
  }
  if (head === null) return false;
  event.preventDefault();
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, selection.anchor, head)).scrollIntoView(),
  );
  return true;
}

/**
 * The block beside a caret the editor cannot draw: at a line's start before a
 * block, or at its end after one, the line having no text on that side and
 * the line break ProseMirror would draw it on hidden (`shell.css`). The last
 * line keeps its break.
 */
function citationAtHiddenCaret(view: EditorView): { pos: number; edge: Edge } | null {
  const { selection, doc } = view.state;
  const { $from } = selection;
  if (!selection.empty || $from.depth !== 1) return null;
  if ($from.parentOffset === 0 && isCitation($from.nodeAfter)) {
    return { pos: $from.pos, edge: "start" };
  }
  const before = $from.nodeBefore;
  if (
    isCitation(before) &&
    $from.parentOffset === $from.parent.content.size &&
    $from.index(0) < doc.childCount - 1
  ) {
    return { pos: $from.pos - before.nodeSize, edge: "end" };
  }
  return null;
}

/** Dispatches a caret move and focuses the editor, or the block's comment where the caret would not show. */
function placeCaret(view: EditorView, tr: Transaction) {
  view.dispatch(tr.scrollIntoView());
  const hidden = citationAtHiddenCaret(view);
  if (hidden && focusCitationComment(view, hidden.pos, hidden.edge)) return;
  view.focus();
}

function findCitation(editor: Editor, matches: (node: ProseMirrorNode) => boolean) {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (isCitation(node) && matches(node)) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found as { pos: number; node: ProseMirrorNode } | null;
}

/**
 * The block: the quote, then the comment's field. `matches` finds its node
 * in the editor's document; `onSave` keeps the comment wherever it lives;
 * `onRemoved` lets go of anything the node held outside the document.
 */
function CitationBlock({
  editor,
  matches,
  quote,
  savedComment,
  maxLength,
  onSave,
  onRemoved,
  focusRequested,
  onFocusHandled,
}: {
  editor: Editor;
  matches: (node: ProseMirrorNode) => boolean;
  quote: ReactNode;
  savedComment: string;
  maxLength: number;
  onSave: (next: string) => void;
  onRemoved?: () => void;
  /** Set when the citation was just inserted: the field takes focus once, if it shows. */
  focusRequested: boolean;
  onFocusHandled: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState(savedComment);
  const [shownComment, setShownComment] = useState(savedComment);
  const tooLong = comment.length > maxLength;

  useEffect(() => {
    if (!focusRequested) return;
    // The editor reacts to losing focus, so the field takes it outside React's commit.
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      // A composer kept mounted out of sight (the thread's, under a file's) leaves it to the one in sight.
      if (input === null || !input.checkVisibility()) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollIntoView({ block: "nearest" });
      onFocusHandled();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequested, onFocusHandled]);

  // An outside change to the comment (an undo, say) shows in the field; the
  // field's own saves only trim it.
  if (savedComment !== shownComment) {
    setShownComment(savedComment);
    if (savedComment !== comment.trim()) setComment(savedComment);
  }

  const save = (next: string) => {
    if (!editor.isEditable || next.length > maxLength) return;
    onSave(next);
  };

  /** Removes the citation, and its line when it stood alone on one. */
  const remove = (focus: boolean) => {
    if (!editor.isEditable) return;
    const found = findCitation(editor, matches);
    if (!found) return;
    const { doc } = editor.state;
    const $pos = doc.resolve(found.pos);
    const alone = $pos.depth === 1 && $pos.parent.childCount === 1 && doc.childCount > 1;
    const from = alone ? $pos.before(1) : found.pos;
    const to = alone ? $pos.after(1) : found.pos + found.node.nodeSize;
    const tr = editor.state.tr.delete(from, to);
    // Without focus the caret is wherever the user put it, mapped past the deletion.
    if (focus) tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1));
    if (focus) placeCaret(editor.view, tr);
    else editor.view.dispatch(tr);
    onRemoved?.();
  };

  /**
   * Puts the editor's caret before or after the block, off its line when it
   * has one; with `newLine`, on an empty line after it, the next line when
   * that is empty, else a new one.
   */
  const leave = (side: "before" | "after", newLine = false) => {
    if (comment.trim() === "") {
      remove(true);
      return;
    }
    const found = findCitation(editor, matches);
    if (!found) return;
    const { doc } = editor.state;
    const tr = editor.state.tr;
    const $pos = doc.resolve(found.pos);
    const end = found.pos + found.node.nodeSize;
    const lineIndex = $pos.index(0);
    const atLineEnd = $pos.depth === 1 && end === $pos.end();
    const next = lineIndex < doc.childCount - 1 ? doc.child(lineIndex + 1) : null;
    if (side === "before") {
      tr.setSelection(
        $pos.depth === 1 && found.pos === $pos.start() && lineIndex > 0
          ? Selection.near(doc.resolve($pos.before(1)), -1)
          : TextSelection.create(doc, found.pos),
      );
    } else if (!newLine || $pos.depth !== 1) {
      tr.setSelection(
        atLineEnd && next
          ? Selection.near(doc.resolve($pos.after(1)), 1)
          : TextSelection.create(doc, end),
      );
    } else if (atLineEnd && next?.type.name === "paragraph" && next.content.size === 0) {
      tr.setSelection(TextSelection.create(doc, $pos.after(1) + 1));
    } else {
      tr.split(end).setSelection(TextSelection.create(tr.doc, end + 2));
    }
    placeCaret(editor.view, tr);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.metaKey || event.ctrlKey) return;
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const input = event.currentTarget;
    const collapsed = input.selectionStart === input.selectionEnd;
    const atStart = collapsed && input.selectionStart === 0;
    const atEnd = collapsed && input.selectionEnd === input.value.length;
    const handle = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (event.altKey) return;
    if (event.shiftKey) {
      if (event.key === "Tab") handle(() => leave("before"));
      return;
    }
    if (event.key === "Enter") return handle(() => leave("after", true));
    if (event.key === "Escape" || event.key === "Tab") return handle(() => leave("after"));
    if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && atStart) {
      return handle(() => leave("before"));
    }
    if ((event.key === "ArrowRight" || event.key === "ArrowDown") && atEnd) {
      return handle(() => leave("after"));
    }
    if ((event.key === "Backspace" && atStart) || (event.key === "Delete" && atEnd)) {
      return handle(() => {
        if (input.value === "") remove(true);
      });
    }
  };

  return (
    // Tinted while the caret is elsewhere, plain while its comment is edited.
    <span className="my-1 flex w-full min-w-0 flex-col gap-0.5 rounded-r-md border-l-2 border-primary bg-primary/8 py-1 pr-2 pl-2.5 transition-colors focus-within:bg-transparent">
      {quote}
      <textarea
        ref={inputRef}
        data-citation-comment-input="true"
        data-citation-comment-trigger="true"
        aria-label="Comment on the quoted text"
        aria-invalid={tooLong || undefined}
        placeholder="Comment…"
        rows={1}
        spellCheck
        className="field-sizing-content block w-full resize-none select-text bg-transparent p-0 text-inherit outline-none placeholder:text-muted-foreground/60"
        value={comment}
        readOnly={!editor.isEditable}
        onChange={(event) => {
          setComment(event.currentTarget.value);
          save(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => event.stopPropagation()}
        onBlur={(event) => {
          const input = event.currentTarget;
          // A window losing focus keeps its active element; only a move within the page leaves.
          if (!input.isConnected || document.activeElement === input) return;
          if (input.value.trim() === "") remove(false);
        }}
      />
      {tooLong ? (
        <span role="status" className="text-xs text-destructive">
          Comments can contain up to {maxLength.toLocaleString()} characters.
        </span>
      ) : null}
    </span>
  );
}

const QUOTE_CLASS_NAME =
  "line-clamp-3 cursor-pointer whitespace-pre-wrap text-muted-foreground no-underline wrap-break-word hover:text-foreground";

/** An assistant citation's block: the quoted text, which goes to it, and the comment, kept as the node's attribute. */
export function ComposerCitationBlock({
  editor,
  citation,
  citeKey,
  focusRequested,
  onFocusHandled,
}: {
  editor: Editor;
  citation: AssistantCitation;
  citeKey: string;
  focusRequested: boolean;
  onFocusHandled: () => void;
}) {
  const navigate = useNavigate();
  const matches = (node: ProseMirrorNode) => node.attrs.citeKey === citeKey;
  return (
    <CitationBlock
      editor={editor}
      matches={matches}
      quote={
        <a
          href="#"
          className={QUOTE_CLASS_NAME}
          title="Go to the quoted text"
          onClick={(event) => {
            event.preventDefault();
            void navigate(assistantCitationNavigation(citation));
          }}
        >
          {citation.text}
        </a>
      }
      savedComment={citation.comment ?? ""}
      maxLength={ASSISTANT_CITATION_MAX_COMMENT_LENGTH}
      onSave={(next) => {
        const found = findCitation(editor, matches);
        if (!found) return;
        const current = found.node.attrs.citation as AssistantCitation;
        const updated = withAssistantCitationComment(current, next);
        if ((updated.comment ?? "") === (current.comment ?? "")) return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(found.pos, undefined, {
            ...found.node.attrs,
            citation: updated,
            source: serializeAssistantCitation(updated),
          }),
        );
      }}
      focusRequested={focusRequested}
      onFocusHandled={onFocusHandled}
    />
  );
}

/** How a file or diff comment's block edits its record in the draft, which the composer provides. */
export const ComposerReviewCommentEditContext = createContext<{
  save: (comment: ReviewCommentContext) => void;
  remove: (commentId: string) => void;
}>({ save: () => {}, remove: () => {} });

/** A file or diff comment's text, the comment, as long as upstream sends one. */
const REVIEW_COMMENT_MAX_LENGTH = 8_000;

/**
 * File and diff comments just cited (the shell's `citations.ts`), whose
 * block takes focus once it shows, in whichever composer is in sight; a
 * request is good for a few seconds.
 */
const reviewCommentFocusRequests = new Map<string, number>();
const FOCUS_REQUEST_TTL_MS = 5_000;

export function requestReviewCommentFocus(commentId: string): void {
  reviewCommentFocusRequests.set(commentId, Date.now());
}

/**
 * A file or diff comment's block: its path and lines, which open the file,
 * the quoted lines, and the comment, kept as the record's text.
 */
export function ComposerReviewCommentBlock({
  editor,
  contextId,
  comment,
}: {
  editor: Editor;
  contextId: string;
  comment: ReviewCommentContext;
}) {
  const edits = use(ComposerReviewCommentEditContext);
  const actions = use(ComposerContextActionsContext);
  const requestedAt = reviewCommentFocusRequests.get(comment.id);
  const [focusRequested, setFocusRequested] = useState(
    requestedAt !== undefined && Date.now() - requestedAt < FOCUS_REQUEST_TTL_MS,
  );
  const quoted = comment.diff.split("\n").filter((line) => !line.startsWith("@@")).join("\n");
  return (
    <CitationBlock
      editor={editor}
      matches={(node) => node.attrs.contextId === contextId}
      quote={
        <span className="flex min-w-0 flex-col gap-0.5">
          <a
            href="#"
            className="truncate text-muted-foreground text-xs no-underline hover:text-foreground"
            title="Open the file"
            onClick={(event) => {
              event.preventDefault();
              actions.openMention(comment.filePath);
            }}
          >
            {comment.filePath} · {comment.sectionTitle === "File comment" ? "" : `${comment.sectionTitle} · `}
            {comment.rangeLabel}
          </a>
          <span className={`${QUOTE_CLASS_NAME} cursor-text font-mono text-xs`}>{quoted}</span>
        </span>
      }
      savedComment={comment.text}
      maxLength={REVIEW_COMMENT_MAX_LENGTH}
      onSave={(next) => {
        if (next.trim() === comment.text) return;
        edits.save({ ...comment, text: next.trim() });
      }}
      onRemoved={() => edits.remove(comment.id)}
      focusRequested={focusRequested}
      onFocusHandled={() => {
        reviewCommentFocusRequests.delete(comment.id);
        setFocusRequested(false);
      }}
    />
  );
}
