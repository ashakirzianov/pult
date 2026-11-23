import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { observeSelectionActions, SELECTION_MULTI_CLICK_INTERVAL_MS } from "./selectionActions";

describe("observeSelectionActions", () => {
  it.each([
    { immediateMultiClick: false, nextFrame: [], afterInterval: [[{ x: 40, y: 12 }]] },
    { immediateMultiClick: true, nextFrame: [[null]], afterInterval: [[null]] },
  ])(
    "double-click with immediateMultiClick=$immediateMultiClick",
    ({ immediateMultiClick, nextFrame, afterInterval }) => {
      using stack = new DisposableStack();
      const element = stack.adopt(document.body.appendChild(document.createElement("div")), (e) =>
        e.remove(),
      );
      stack.use(fakeTimers());
      const onSelection = vi.fn();
      const actions = observeSelectionActions({
        element,
        immediateMultiClick,
        onSelection,
        onDismiss: () => {},
      });
      stack.defer(() => actions.dispose());

      element.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      element.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          detail: 2,
          clientX: 40,
          clientY: 12,
        }),
      );

      vi.advanceTimersByTime(20);
      expect(onSelection.mock.calls).toEqual(nextFrame);
      vi.advanceTimersByTime(SELECTION_MULTI_CLICK_INTERVAL_MS - 21);
      expect(onSelection.mock.calls).toEqual(nextFrame);
      vi.advanceTimersByTime(50);
      expect(onSelection.mock.calls).toEqual(afterInterval);
    },
  );

  it("follows a selection in a frame that runs no script, hearing its document scroll", async () => {
    using stack = new DisposableStack();
    const frame = stack.adopt(document.createElement("iframe"), (e) => e.remove());
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.srcdoc = "<!doctype html><p>Text</p>";
    const loaded = new Promise((resolve) =>
      frame.addEventListener("load", resolve, { once: true }),
    );
    document.body.append(frame);
    await loaded;
    const doc = frame.contentDocument!;
    const element = doc.documentElement;
    stack.use(fakeTimers());
    const onSelection = vi.fn();
    const onDismiss = vi.fn();
    const actions = observeSelectionActions({
      element,
      scrollTarget: doc,
      onSelection,
      onDismiss,
    });
    stack.defer(() => actions.dispose());

    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
    );
    element.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1, clientX: 4, clientY: 6 }),
    );
    vi.advanceTimersByTime(20);
    expect(onSelection.mock.calls).toEqual([[{ x: 4, y: 6 }]]);

    onDismiss.mockClear();
    doc.dispatchEvent(new Event("scroll"));
    expect(onDismiss.mock.calls).toEqual([["cancel"]]);
  });
});
