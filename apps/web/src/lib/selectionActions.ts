export type SelectionActionPoint = { x: number; y: number };

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;
const SELECTION_SCROLL_SETTLE_MS = 150;

export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: SelectionActionPoint | null;
  viewport: { width: number; height: number };
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport } = options;
  const preferred = pointer ?? {
    x: selectionRect?.right ?? bounds.left + bounds.width - 140,
    y: selectionRect ? selectionRect.bottom + 4 : bounds.top + 12,
  };
  return {
    x: Math.max(
      8,
      Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8),
    ),
    y: Math.max(
      8,
      Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8),
    ),
  };
}

type SelectionRect = { left: number; top: number; right: number; bottom: number };

export function isSelectionRectVisible(rect: SelectionRect, clips: readonly SelectionRect[]) {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

/**
 * Whether any selected text shows inside `viewport`, whose box is `viewportRect`, past every
 * clipping ancestor. Pult: here so the shell's reader tells the same, in a frame's document.
 */
export function isSelectionTextVisible(
  range: Range,
  viewport: HTMLElement,
  viewportRect: SelectionRect,
): boolean {
  const owner = viewport.ownerDocument;
  const styleOf = (element: Element) => owner.defaultView!.getComputedStyle(element);
  // A selection can cross blocks with different clipping ancestors.
  const common = range.commonAncestorContainer;
  const walker = owner.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
  for (; node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node.parentElement && styleOf(node.parentElement).userSelect === "none") continue;
    const fragment = owner.createRange();
    fragment.selectNodeContents(node);
    if (node === range.startContainer) fragment.setStart(node, range.startOffset);
    if (node === range.endContainer) fragment.setEnd(node, range.endOffset);
    if (!fragment.toString().trim()) continue;
    const lines = Array.from(fragment.getClientRects());
    if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
    const clips: SelectionRect[] = [viewportRect];
    for (
      let element = node.parentElement;
      element && element !== viewport;
      element = element.parentElement
    ) {
      const style = styleOf(element);
      const clipX = style.overflowX !== "visible";
      const clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const bounds = element.getBoundingClientRect();
      const left = bounds.left + element.clientLeft;
      const top = bounds.top + element.clientTop;
      clips.push({
        left: clipX ? left : -Infinity,
        right: clipX ? left + element.clientWidth : Infinity,
        top: clipY ? top : -Infinity,
        bottom: clipY ? top + element.clientHeight : Infinity,
      });
    }
    if (lines.some((line) => isSelectionRectVisible(line, clips))) return true;
  }
  return false;
}

/**
 * Interactive popovers pass getActionElement to keep editing their fields from replacing the
 * captured source selection.
 */
export function observeSelectionActions({
  element,
  scrollTarget = element,
  getActionElement,
  restoreAfterScroll = false,
  immediateMultiClick = false,
  onSelection,
  onDismiss,
}: {
  element: HTMLElement;
  /** Pult: where its scrolling is heard when that is not `element`: a reader frame's document. */
  scrollTarget?: EventTarget;
  getActionElement?: () => HTMLElement | null;
  restoreAfterScroll?: boolean;
  /**
   * Show double- and triple-click selections at once instead of waiting out the multi-click
   * interval. Their pointer is withheld so the action anchors below the selection, clear of
   * the spot where a following click lands.
   */
  immediateMultiClick?: boolean;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let restorable = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: number | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target !== null && (getActionElement?.()?.contains(target as Node) ?? false);

  const cancelPending = () => {
    if (timer !== null) window.clearTimeout(timer);
    if (frame !== null) window.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
    restorable = false;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const onContextMenu = () => {
    cancel();
    onDismiss("interaction");
  };
  const schedule = (delay: number) => {
    restorable = true;
    cancelPending();
    // Pult: the page's timers, since a reader's sandboxed frame runs none of its own.
    timer = window.setTimeout(() => {
      timer = null;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = event.button === 0;
    const inside = element.contains(event.target as Node);
    gestureActive = false;
    dismissed = true;
    restorable = false;
    pointer = null;
    if (inside) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };
  const onSelectionStart = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const target = event.target as Element | null;
    if (target?.closest("button, [role=button]")) return;
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    // Preventing pointerdown (for example on a toolbar) can suppress mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    const multiClick = event.detail >= 2;
    pointer = multiClick && immediateMultiClick ? null : { x: event.clientX, y: event.clientY };
    schedule(multiClick && !immediateMultiClick ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      if (restoreAfterScroll && !dismissed && restorable) schedule(SELECTION_SCROLL_SETTLE_MS);
      else dismissed = true;
    }
    onDismiss("cancel");
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("mouseup", onMouseUp);
  view.addEventListener("pointercancel", dismiss);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", onContextMenu, true);
  scrollTarget.addEventListener("scroll", onScroll, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    get pending() {
      return timer !== null || frame !== null;
    },
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss("cancel");
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp);
      view.removeEventListener("mouseup", onMouseUp);
      view.removeEventListener("pointercancel", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", onContextMenu, true);
      scrollTarget.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}
