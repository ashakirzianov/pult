import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
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
 * The editor's side of the block's keys. A block moves as one character, the
 * caret resting before and after it, drawn as a bar above or below it
 * (`citationCaret`): Left and Right step onto a bar and over the block, as do
 * Up and Down, which keep the caret's column from line to line; Backspace or
 * Delete into a block enters its comment, at the end or at the start, and at
 * a bar facing a line, Backspace goes to the end of the line before, deleting
 * it when empty, and Delete deletes an empty line after. With Shift, and
 * Option or not, the arrows extend the selection over the block alone,
 * Option+Up and Option+Down off a line's edge left to the platform. Returns
 * whether it handled the key.
 */
export function enterComposerCitationByKey(view: EditorView, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.isComposing) return false;
  if (event.shiftKey) return extendOverCitation(view, event);
  if (event.altKey || !view.state.selection.empty) return false;
  const { $from } = view.state.selection;
  const { doc } = view.state;
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  const atBar = citationCaret(doc, $from.pos) !== null;
  if (event.key === "Backspace" || event.key === "Delete") {
    const back = event.key === "Backspace";
    const pos = back ? citationBehind(view, $from) : citationAhead(view, $from);
    if (pos !== null && focusCitationComment(view, pos, back ? "end" : "start")) return handled();
    if (!atBar) return false;
    // Deleting the line break on the bar's side would join the block's line to the next one.
    const index = $from.index(0);
    const neighbour = back
      ? index > 0
        ? doc.child(index - 1)
        : null
      : index < doc.childCount - 1
        ? doc.child(index + 1)
        : null;
    if (neighbour?.type.name === "paragraph" && neighbour.content.size === 0) {
      const at = back ? $from.before(1) - neighbour.nodeSize : $from.after(1);
      view.dispatch(view.state.tr.delete(at, at + neighbour.nodeSize).scrollIntoView());
    } else if (back && neighbour !== null) {
      view.dispatch(
        view.state.tr
          .setSelection(Selection.near(doc.resolve($from.before(1)), -1))
          .scrollIntoView(),
      );
    }
    return handled();
  }
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
  const dir = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  if (!vertical && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
  let target: number | null;
  const goal = goalColumns.get(view);
  let x = goal?.at === $from.pos ? goal.x : null;
  if (!vertical || atBar) {
    target = stepOverCitation(doc, $from.pos, dir);
  } else {
    if (!view.endOfTextblock(dir < 0 ? "up" : "down")) return false;
    const pos = dir < 0 ? citationBehind(view, $from, true) : citationAhead(view, $from, true);
    if (pos === null) return false;
    target = dir < 0 ? pos + doc.nodeAt(pos)!.nodeSize : canonicalCaret(doc, pos);
    x = view.coordsAtPos($from.pos).left;
  }
  // A bar with nothing past it keeps the caret: the editor's own move would put it in the block.
  if (target === null) return atBar ? handled() : false;
  if (vertical && x !== null) {
    if (citationCaret(doc, target) === null) target = inColumn(view, target, x, dir);
    else goalColumns.set(view, { x, at: target });
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)).scrollIntoView());
  return handled();
}

/** The column Up and Down over blocks keep, while the caret is on the bar they put it on. */
const goalColumns = new WeakMap<EditorView, { x: number; at: number }>();

/**
 * Where the caret beside a block goes, back (-1) or forward (1): over the
 * block, or off its line to the line beside; between two blocks, one caret
 * stands for both sides (`canonicalCaret`). Null when the move is not over a
 * block or a bar has nowhere to go.
 */
function stepOverCitation(doc: ProseMirrorNode, pos: number, dir: -1 | 1): number | null {
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 1) return null;
  const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
  if (isCitation(node)) return canonicalCaret(doc, pos + dir * node.nodeSize);
  const index = $pos.index(0);
  const atEdge =
    dir < 0
      ? $pos.parentOffset === 0 && index > 0
      : $pos.parentOffset === $pos.parent.content.size && index < doc.childCount - 1;
  if (!atEdge) return null;
  const line = doc.child(index + dir);
  const facing = dir < 0 ? line.lastChild : line.firstChild;
  const beyond = dir < 0 ? $pos.before(1) - 1 : $pos.after(1) + 1;
  if (isCitation(facing) && isCitation(dir < 0 ? $pos.nodeAfter : $pos.nodeBefore)) {
    return canonicalCaret(doc, beyond + dir * facing.nodeSize);
  }
  if (isCitation(facing) || citationCaret(doc, pos) !== null) return canonicalCaret(doc, beyond);
  return null;
}

/** The caret on `pos`'s visual row nearest `x`, for Up (-1) or Down (1) off a bar; `pos` itself when the row's caret would land elsewhere. */
function inColumn(view: EditorView, pos: number, x: number, dir: -1 | 1): number {
  const { doc } = view.state;
  const row = view.coordsAtPos(pos);
  const found = view.posAtCoords({ left: x, top: (row.top + row.bottom) / 2 });
  if (found === null) return pos;
  const $found = doc.resolve(found.pos);
  const $pos = doc.resolve(pos);
  const sameLine = $found.depth === 1 && $pos.depth === 1 && $found.index(0) === $pos.index(0);
  const onSide = dir < 0 ? found.pos <= pos : found.pos >= pos;
  return sameLine && onSide && citationCaret(doc, found.pos) === null ? found.pos : pos;
}

/** Whether the selection's head is on its line's first or last visual row; the editor's own check reads the selection's start or end. */
function headOnEdgeLine(view: EditorView, dir: "up" | "down"): boolean {
  const { state } = view;
  const collapsed = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, state.selection.head)),
  );
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
 * The caret at `pos` when it is beside a block where the editor cannot draw
 * it: at a line's start before a block, or at its end after one, the line
 * having no text on that side and the line break ProseMirror would draw it on
 * hidden (`shell.css`). It is drawn as a bar above or below the block
 * (`ComposerCitationCaretExtension`); between two blocks, one bar under the
 * first.
 */
function citationCaret(
  doc: ProseMirrorNode,
  pos: number,
): { pos: number; side: "before" | "after" } | null {
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 1) return null;
  const before = $pos.nodeBefore;
  if (isCitation(before) && $pos.parentOffset === $pos.parent.content.size) {
    return { pos: pos - before.nodeSize, side: "after" };
  }
  if ($pos.parentOffset !== 0 || !isCitation($pos.nodeAfter)) return null;
  const canonical = canonicalCaret(doc, pos);
  return canonical === pos ? { pos, side: "before" } : citationCaret(doc, canonical);
}

/** The one caret between two blocks, the end of the first one's line, for `pos` at the second one's start. */
function canonicalCaret(doc: ProseMirrorNode, pos: number): number {
  const $pos = doc.resolve(pos);
  if ($pos.depth !== 1 || $pos.parentOffset !== 0 || !isCitation($pos.nodeAfter)) return pos;
  const index = $pos.index(0);
  return index > 0 && isCitation(doc.child(index - 1).lastChild) ? $pos.before(1) - 1 : pos;
}

/**
 * A transaction putting the caret beside a block on a line of its own: the
 * empty line on its side, else a new one; null with the caret elsewhere.
 */
function openLineAtCitationCaret(state: EditorState): Transaction | null {
  const { selection, doc, schema } = state;
  const caret = selection.empty ? citationCaret(doc, selection.from) : null;
  if (caret === null) return null;
  const $citation = doc.resolve(caret.pos);
  const before = caret.side === "before";
  const neighbour = doc.maybeChild($citation.index(0) + (before ? -1 : 1));
  if (neighbour?.type.name === "paragraph" && neighbour.content.size === 0) {
    const inside = before ? $citation.before(1) - 1 : $citation.after(1) + 1;
    return state.tr.setSelection(TextSelection.create(doc, inside));
  }
  const at = before ? $citation.before(1) : $citation.after(1);
  const tr = state.tr.insert(at, schema.nodes.paragraph!.create());
  return tr.setSelection(TextSelection.create(tr.doc, at + 1));
}

/**
 * The caret beside a block (`citationCaret`): a bar above or below the block,
 * marked on its node for `shell.css`, the editor's own caret hidden; what is
 * typed or pasted there goes on a line of its own.
 */
export const ComposerCitationCaretExtension = Extension.create({
  name: "composer-citation-caret",
  // Ahead of the input rules, which would take the typed text first.
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { selection, doc } = state;
            const caret = selection.empty ? citationCaret(doc, selection.from) : null;
            if (caret === null) return null;
            const size = doc.nodeAt(caret.pos)!.nodeSize;
            return DecorationSet.create(doc, [
              Decoration.node(caret.pos, caret.pos + size, { "data-citation-caret": caret.side }),
            ]);
          },
          attributes(state): Record<string, string> {
            const { selection, doc } = state;
            return selection.empty && citationCaret(doc, selection.from) !== null
              ? { "data-caret-at-citation": "" }
              : {};
          },
          handleTextInput(view, _from, _to, text) {
            const tr = openLineAtCitationCaret(view.state);
            if (tr === null) return false;
            view.dispatch(tr.insertText(text).scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            paste(view) {
              const tr = openLineAtCitationCaret(view.state);
              if (tr !== null) view.dispatch(tr);
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** Dispatches a caret move and focuses the editor. */
function placeCaret(view: EditorView, tr: Transaction) {
  view.dispatch(tr.scrollIntoView());
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

  /**
   * Removes the citation, and its line when it stood alone on one. With
   * `dir`, the editor's caret goes where it stood, from the side before (-1)
   * or after (1).
   */
  const remove = (dir?: -1 | 1) => {
    if (!editor.isEditable) return;
    const found = findCitation(editor, matches);
    if (!found) return;
    const { doc } = editor.state;
    const $pos = doc.resolve(found.pos);
    const alone = $pos.depth === 1 && $pos.parent.childCount === 1 && doc.childCount > 1;
    const from = alone ? $pos.before(1) : found.pos;
    const to = alone ? $pos.after(1) : found.pos + found.node.nodeSize;
    const tr = editor.state.tr.delete(from, to);
    if (dir) {
      const near = Selection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), dir);
      tr.setSelection(
        near instanceof TextSelection && near.empty
          ? TextSelection.create(tr.doc, canonicalCaret(tr.doc, near.from))
          : near,
      );
      placeCaret(editor.view, tr);
    } else {
      // Without focus the caret is wherever the user put it, mapped past the deletion.
      editor.view.dispatch(tr);
    }
    onRemoved?.();
  };

  /**
   * Puts the editor's caret before or after the block, on its bar where
   * the block has its line to itself (`citationCaret`); with `newLine`, on
   * an empty line after it, the next line when that is empty, else a new
   * one.
   */
  const leave = (side: "before" | "after", newLine = false) => {
    if (comment.trim() === "") {
      remove(side === "before" ? -1 : 1);
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
    if (side === "before" || !newLine || $pos.depth !== 1) {
      tr.setSelection(
        TextSelection.create(doc, side === "before" ? canonicalCaret(doc, found.pos) : end),
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
        if (input.value === "") remove(event.key === "Backspace" ? -1 : 1);
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
          if (input.value.trim() === "") remove();
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
  const quoted = comment.diff
    .split("\n")
    .filter((line) => !line.startsWith("@@"))
    .join("\n");
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
            {comment.filePath} ·{" "}
            {comment.sectionTitle === "File comment" ? "" : `${comment.sectionTitle} · `}
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
