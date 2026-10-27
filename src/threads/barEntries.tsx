import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { HoverPosition } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/hover/hoverWidget";
import { IHoverService } from "@codingame/monaco-vscode-api/vscode/vs/platform/hover/browser/hover.service";
import { type FocusEvent, type MouseEvent, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { threadStore } from "./store.ts";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** The workbench's hover above `target`, as the status bar shows one; it hides when the pointer leaves both. */
function showHover(target: HTMLElement, content: string) {
  void getService(IHoverService).then((hovers) =>
    hovers.showInstantHover({ content, target, position: { hoverPosition: HoverPosition.ABOVE }, appearance: { showPointer: true } }),
  );
}

/** Hover and click both show the entry's hover, so a keyboard or a touch reaches it too. */
const hoverProps = (content: string) => ({
  "aria-label": content,
  onMouseEnter: (event: MouseEvent<HTMLElement>) => showHover(event.currentTarget, content),
  onFocus: (event: FocusEvent<HTMLElement>) => showHover(event.currentTarget, content),
});

/**
 * The thread's place, as entries of its pane's composer bar, which the
 * thread view provides (`ThreadViewMounts`): Explorer, an icon button that
 * opens the Explorer tab narrowed to the thread's root (a note when the
 * thread has none), the branch when the server records one, and the
 * environment, an icon whose name shows in a hover on hover or click. The
 * bar orders its entries by their `data-chat-composer-slot-item`.
 */
export function ThreadBarEntries({ bar, threadId }: { bar: HTMLElement; threadId: string }) {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return null;
  const environment = state.environment === null ? null : `Environment: ${state.environment.label}`;
  return createPortal(
    <div data-chat-composer-slot-item="shell" className="pult-bar-entries">
      {thread.projectRoot === null ? (
        <span className="pult-bar-entry">No project folder</span>
      ) : (
        <button
          type="button"
          className="pult-bar-entry pult-bar-button"
          {...hoverProps("Explorer")}
          onClick={() => void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.openThreadExplorer"))}
        >
          <i className="codicon codicon-files" aria-hidden />
        </button>
      )}
      {thread.branch ? (
        <span className="pult-bar-entry" title={thread.branch}>
          <i className="codicon codicon-git-branch" aria-hidden />
          <span className="pult-bar-entry-label">{thread.branch}</span>
        </span>
      ) : null}
      {environment === null ? null : (
        <button
          type="button"
          className="pult-bar-entry pult-bar-button"
          {...hoverProps(environment)}
          onClick={(event) => showHover(event.currentTarget, environment)}
        >
          <i className="codicon codicon-vm" aria-hidden />
        </button>
      )}
    </div>,
    bar,
  );
}
