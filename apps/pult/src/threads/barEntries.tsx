import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { lazy, type ReactElement, Suspense, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { threadStore } from "./store.ts";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

// Loaded with the view rather than with the page: upstream's modules read state as they load.
const BarTooltip = lazy(() => import("../../thread-view/shell/BarTooltip.tsx"));

/**
 * `children`, an entry of a composer bar, named in upstream's tooltip on
 * hover and keyboard focus, as the bar's own buttons are; the entry alone
 * until the tooltip loads.
 */
export function BarTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Suspense fallback={children}>
      <BarTooltip label={label}>{children}</BarTooltip>
    </Suspense>
  );
}

/**
 * The thread's place, as entries of its pane's composer bar, which the
 * thread view provides (`ThreadViewMounts`): Explorer, an icon button that
 * opens the Explorer tab narrowed to the thread's root (a note when the
 * thread has none), Source Control, one that opens the changes view narrowed
 * to the thread's checkout (`pult-shell.showChanges`), and the environment,
 * an icon whose name shows in a tooltip. The bar orders its entries by their
 * `data-chat-composer-slot-item`.
 */
export function ThreadBarEntries({ bar, environmentId, threadId }: { bar: HTMLElement; environmentId: string; threadId: string }) {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const thread = state.threads.find((candidate) => candidate.id === threadId && candidate.environmentId === environmentId);
  if (thread === undefined) return null;
  const held = state.environments.find((candidate) => candidate.id === environmentId);
  const environment =
    held === undefined ? null : `Environment: ${held.label}${held.name === held.label ? "" : ` (${held.name})`}`;
  const run = (command: string, ...args: unknown[]) =>
    void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
  return (
    <>
      {createPortal(
        <div data-chat-composer-slot-item="shell" className="pult-bar-entries">
          {thread.projectRoot === null ? (
            <span className="pult-bar-entry">No project folder</span>
          ) : (
            <BarTip label="Explorer">
              <button
                type="button"
                className="pult-bar-entry pult-bar-button"
                aria-label="Explorer"
                onClick={() => run("pult-shell.openThreadExplorer")}
              >
                <i className="codicon codicon-files" aria-hidden />
              </button>
            </BarTip>
          )}
          {thread.checkoutRoot === null ? null : (
            <BarTip label="Source Control">
              <button
                type="button"
                className="pult-bar-entry pult-bar-button"
                aria-label="Source Control"
                onClick={() => run("pult-shell.showChanges", environmentId, threadId, null)}
              >
                <i className="codicon codicon-source-control" aria-hidden />
              </button>
            </BarTip>
          )}
        </div>,
        bar,
      )}
      {environment === null
        ? null
        : createPortal(
            <div data-chat-composer-slot-item="environment" className="pult-bar-entries">
              <BarTip label={environment}>
                <button type="button" className="pult-bar-entry pult-bar-button" aria-label={environment}>
                  <i className="codicon codicon-vm" aria-hidden />
                </button>
              </BarTip>
            </div>,
            bar,
          )}
    </>
  );
}
