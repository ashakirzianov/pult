import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";

// Pult's composer citation: a block on its own line, the quote and then the
// user's comment, edited in place. The comment is the node's attribute, not
// document content, so the field is the node view's own textarea; the editor
// enters it by key (`enterComposerCitationByKey`) and the field leaves it by
// key. A comment left empty when the field loses focus removes the citation.

const CITATION_NODE = "composer-citation";
const COMMENT_INPUT_SELECTOR = "textarea[data-citation-comment-input]";

type Edge = "start" | "end";

function isCitation(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return node?.type.name === CITATION_NODE;
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
 * The citation the caret would delete or step into going backward, and its
 * position; `lineAbove` takes the previous line's from anywhere on this one.
 */
function citationBehind(view: EditorView, lineAbove = false): number | null {
  const { $from } = view.state.selection;
  const before = $from.nodeBefore;
  if (isCitation(before)) return $from.pos - before.nodeSize;
  if ($from.depth !== 1 || (!lineAbove && $from.parentOffset !== 0) || $from.index(0) === 0) {
    return null;
  }
  const previous = view.state.doc.child($from.index(0) - 1);
  const last = previous.lastChild;
  if (previous.type.name !== "paragraph" || !isCitation(last)) return null;
  return $from.before(1) - 1 - last.nodeSize;
}

/**
 * The citation the caret would delete or step into going forward, and its
 * position; `lineBelow` takes the next line's from anywhere on this one.
 */
function citationAhead(view: EditorView, lineBelow = false): number | null {
  const { $from } = view.state.selection;
  if (isCitation($from.nodeAfter)) return $from.pos;
  const { doc } = view.state;
  if (
    $from.depth !== 1 ||
    (!lineBelow && $from.parentOffset !== $from.parent.content.size) ||
    $from.index(0) >= doc.childCount - 1
  ) {
    return null;
  }
  const next = doc.child($from.index(0) + 1);
  if (next.type.name !== "paragraph" || !isCitation(next.firstChild)) return null;
  return $from.after(1) + 1;
}

/**
 * The editor's side of the block's keys: Backspace and Left (or Up off the
 * first line) into a block enter its comment at the end, Delete and Right (or
 * Down off the last line) at the start. Returns whether it handled the key.
 */
export function enterComposerCitationByKey(view: EditorView, event: KeyboardEvent): boolean {
  if (
    event.shiftKey ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.isComposing ||
    !view.state.selection.empty
  ) {
    return false;
  }
  const target =
    event.key === "Backspace" || event.key === "ArrowLeft"
      ? { pos: citationBehind(view), edge: "end" as const }
      : event.key === "ArrowUp" && view.endOfTextblock("up")
        ? { pos: citationBehind(view, true), edge: "end" as const }
        : event.key === "Delete" || event.key === "ArrowRight"
          ? { pos: citationAhead(view), edge: "start" as const }
          : event.key === "ArrowDown" && view.endOfTextblock("down")
            ? { pos: citationAhead(view, true), edge: "start" as const }
            : null;
  if (target?.pos == null || !focusCitationComment(view, target.pos, target.edge)) return false;
  event.preventDefault();
  event.stopPropagation();
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

function findCitation(editor: Editor, citeKey: string) {
  let found: { pos: number; node: ProseMirrorNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (isCitation(node) && node.attrs.citeKey === citeKey) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found as { pos: number; node: ProseMirrorNode } | null;
}

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
  /** Set when the citation was just inserted: the field takes focus once. */
  focusRequested: boolean;
  onFocusHandled: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const savedComment = citation.comment ?? "";
  const [comment, setComment] = useState(savedComment);
  const [shownComment, setShownComment] = useState(savedComment);
  const tooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;

  useEffect(() => {
    if (!focusRequested) return;
    // The editor reacts to losing focus, so the field takes it outside React's commit.
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
        input.scrollIntoView({ block: "nearest" });
      }
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
    if (!editor.isEditable || next.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH) return;
    const found = findCitation(editor, citeKey);
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
  };

  /** Removes the citation, and its line when it stood alone on one. */
  const remove = (focus: boolean) => {
    if (!editor.isEditable) return;
    const found = findCitation(editor, citeKey);
    if (!found) return;
    const { doc } = editor.state;
    const $pos = doc.resolve(found.pos);
    const alone = $pos.depth === 1 && $pos.parent.childCount === 1 && doc.childCount > 1;
    const from = alone ? $pos.before(1) : found.pos;
    const to = alone ? $pos.after(1) : found.pos + found.node.nodeSize;
    const tr = editor.state.tr.delete(from, to);
    // Without focus the caret is wherever the user put it, mapped past the deletion.
    if (!focus) return void editor.view.dispatch(tr);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1));
    placeCaret(editor.view, tr);
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
    const found = findCitation(editor, citeKey);
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
      <a
        href="#"
        className="line-clamp-3 cursor-pointer whitespace-pre-wrap text-muted-foreground no-underline wrap-break-word hover:text-foreground"
        title="Go to the quoted text"
        onClick={(event) => {
          event.preventDefault();
          void navigate(assistantCitationNavigation(citation));
        }}
      >
        {citation.text}
      </a>
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
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </span>
      ) : null}
    </span>
  );
}
