import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { threadStore } from "./store.ts";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/**
 * The thread's place, as entries of its pane's composer bar, which the
 * thread view provides (`ThreadViewMounts`): Explorer, the button that opens
 * the Explorer tab narrowed to the thread's root (a note when the thread has
 * none), the branch when the server records one, and the environment. The
 * bar orders its entries by their `data-chat-composer-slot-item`.
 */
export function ThreadBarEntries({ bar, threadId }: { bar: HTMLElement; threadId: string }) {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return null;
  return createPortal(
    <div data-chat-composer-slot-item="shell" className="pult-bar-entries">
      {thread.projectRoot === null ? (
        <span className="pult-bar-entry">No project folder</span>
      ) : (
        <button
          type="button"
          className="pult-bar-entry pult-bar-button"
          onClick={() => void getService(ICommandService).then((commands) => commands.executeCommand("pult-shell.openThreadExplorer"))}
        >
          <i className="codicon codicon-files" aria-hidden />
          Explorer
        </button>
      )}
      {thread.branch ? (
        <span className="pult-bar-entry" title={thread.branch}>
          <i className="codicon codicon-git-branch" aria-hidden />
          <span className="pult-bar-entry-label">{thread.branch}</span>
        </span>
      ) : null}
      {state.environment ? (
        <span className="pult-bar-entry">
          <i className="codicon codicon-vm" aria-hidden />
          <span className="pult-bar-entry-label">{state.environment.label}</span>
        </span>
      ) : null}
    </div>,
    bar,
  );
}
