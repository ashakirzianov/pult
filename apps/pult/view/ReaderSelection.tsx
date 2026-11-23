// The thread's selection action on a reader's page (`src/reader/pane.ts`):
// upstream's "Type to cite" button and its gesture rules over a selection in
// the reader's frame, the button in the shell's page, placed over the frame.
import { StrictMode, useEffect, useEffectEvent, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { isCitationKey, SelectionCiteButton } from "~/components/chat/AssistantSelectionToolbar";
import { I18nProvider } from "~/i18n/I18nProvider";
import {
  isSelectionTextVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";

/** What the reader offers and cites: `Capture` is its own, read as the action shows. */
interface ReaderSelectionHost<Capture> {
  /** The page's selection to cite now, none when Cite would take nothing. */
  capture(): { readonly capture: Capture; readonly tooLong: boolean } | undefined;
  /** Cites it, `comment` the key typed on it. */
  cite(capture: Capture, comment?: string): void;
}

export interface MountedReaderSelection {
  /** The frame rendered again: its document has a new root, and no selection. */
  update(): void;
  dispose(): void;
}

function ReaderSelection<Capture>({
  frame,
  doc,
  root,
  host,
}: {
  frame: HTMLIFrameElement;
  doc: Document;
  root: HTMLElement;
  host: ReaderSelectionHost<Capture>;
}) {
  const [selection, setSelection] = useState<{
    capture: Capture;
    tooLong: boolean;
    position: SelectionActionPoint;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  // Tab moves the keyboard to the button, out of the frame, whose blur is otherwise a dismissal.
  const movingFocus = useRef(false);

  useEffect(() => {
    const clear = () => {
      if (!movingFocus.current) setSelection(null);
    };
    const update = (pointer: SelectionActionPoint | null) => {
      const captured = host.capture();
      const native = doc.getSelection();
      if (!captured || !native || native.rangeCount === 0) return setSelection(null);
      const range = native.getRangeAt(0);
      const shown = { left: 0, top: 0, right: frame.clientWidth, bottom: frame.clientHeight };
      if (!isSelectionTextVisible(range, root, shown)) return setSelection(null);
      const rects = [...range.getClientRects()];
      const last = rects.at(-1) ?? range.getBoundingClientRect();
      const bounds = frame.getBoundingClientRect();
      const pointerOnText =
        pointer !== null &&
        rects.some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSelection({
        ...captured,
        position: resolveSelectionActionPosition({
          bounds,
          selectionRect: { right: bounds.left + last.right, bottom: bounds.top + last.bottom },
          pointer: pointerOnText ? { x: bounds.left + pointer.x, y: bounds.top + pointer.y } : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: root,
      scrollTarget: doc,
      getActionElement: () => buttonRef.current,
      restoreAfterScroll: true,
      immediateMultiClick: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusButton = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !button ||
        button.disabled
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      movingFocus.current = true;
      button.focus({ preventScroll: true });
    };
    // After the observer's own blur listener, which the move to the button must not dismiss.
    const movedFocus = () => {
      movingFocus.current = false;
    };
    doc.defaultView?.addEventListener("blur", movedFocus);
    doc.addEventListener("keydown", focusButton, true);
    doc.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      doc.defaultView?.removeEventListener("blur", movedFocus);
      doc.removeEventListener("keydown", focusButton, true);
      doc.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [doc, frame, host, root]);

  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = (comment?: string) => {
    if (!selection || selection.tooLong) return false;
    host.cite(selection.capture, comment);
    doc.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const citeTyped = useEffectEvent((event: KeyboardEvent) => {
    if (!isCitationKey(event)) return;
    if (event.currentTarget === document && document.activeElement !== buttonRef.current) return;
    if (doc.activeElement?.matches("input, textarea, select, [contenteditable]")) return;
    if (cite(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  const shown = selection !== null;

  useEffect(() => {
    if (!shown) return;
    // The keyboard gone anywhere but the frame or the button ends it, as focus elsewhere does in the thread.
    const focusMoved = (event: FocusEvent) => {
      if (event.target !== frame && event.target !== buttonRef.current) {
        actionsRef.current?.cancel();
        setSelection(null);
      }
    };
    doc.addEventListener("keydown", citeTyped, true);
    document.addEventListener("keydown", citeTyped, true);
    document.addEventListener("focusin", focusMoved);
    return () => {
      doc.removeEventListener("keydown", citeTyped, true);
      document.removeEventListener("keydown", citeTyped, true);
      document.removeEventListener("focusin", focusMoved);
    };
  }, [doc, frame, shown]);

  if (!selection) return null;
  return (
    <SelectionCiteButton
      buttonRef={buttonRef}
      position={selection.position}
      tooLong={selection.tooLong}
      onCite={() => cite()}
      onDismiss={dismiss}
    />
  );
}

/** Shows the thread's selection action over `frame` for a selection in `doc`, until disposed. */
export function mountReaderSelection<Capture>(
  frame: HTMLIFrameElement,
  doc: Document,
  host: ReaderSelectionHost<Capture>,
): MountedReaderSelection {
  const reactRoot = createRoot(document.createElement("div"));
  // Each render of the page is a new root with no selection, so the action starts over.
  let renders = 0;
  const render = () =>
    reactRoot.render(
      <StrictMode>
        <I18nProvider>
          <ReaderSelection
            key={++renders}
            frame={frame}
            doc={doc}
            root={doc.documentElement}
            host={host}
          />
        </I18nProvider>
      </StrictMode>,
    );
  render();
  return { update: render, dispose: () => reactRoot.unmount() };
}
