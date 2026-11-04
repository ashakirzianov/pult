import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { lazy, Suspense, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { connection } from "../connection/index.ts";
import { BarTip } from "../threads/barEntries.tsx";
import { draftCreates, type PaneTarget, ThreadContent } from "../threads/pane.tsx";
import { threadStore } from "../threads/store.ts";
import { starById, starStore, type StarTarget, starTarget } from "./model.ts";
import { starName } from "./stars.ts";
import "./stars.css";

// With the view, whose markdown its transcripts render with.
const StarFold = lazy(() => import("./fold.tsx"));

const subscribeToConnection = (listener: () => void) => connection.onDidChange(listener);
const environmentsSnapshot = () => connection.environments;
const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

const sameTarget = (left: StarTarget | undefined, right: StarTarget | undefined) => JSON.stringify(left) === JSON.stringify(right);

/**
 * How the Star's composer reads, in its tab and in the composer strip under
 * its files: asleep, its draft rests where a thread's composer sits, under
 * the fold, without upstream's hero, which asks what to build in a project
 * and offers to start without one; awake or asleep, it addresses the Star,
 * "Message Star", or its name once it has one.
 */
export function starComposerOptions(starId: string) {
  return {
    draftHero: false,
    placeholder: {
      get: () => `Message ${starName(starById(starId) ?? { name: "" })}`,
      subscribe: starStore.subscribe,
    },
  };
}

/**
 * The Star's tab: one scroller, the fold of its earlier conversations at the
 * top of the timeline (`fold.tsx`, rendered by the view into the element its
 * timeline places there), then its current conversation's view, mounted as the
 * thread pane mounts a thread on its environment, or while the Star sleeps
 * its project's draft (`new-thread-draft`'s), in the home it wakes in
 * (`starTarget`). Writing to the draft wakes the Star: the view stays
 * mounted as the thread it creates, which becomes the current conversation,
 * whether the view or the store names the thread first; told by the store,
 * the view goes to the thread at once (`ThreadContent`, `MountedView.follow`)
 * rather than wait to go there itself. Any other change of what the Star
 * shows (it falls asleep, another page woke it) mounts the view again on it.
 */
export function StarContent({ starId }: { starId: string }) {
  const star = useSyncExternalStore(starStore.subscribe, () => starById(starId));
  // Where a sleeping Star wakes depends on which environments the page holds.
  useSyncExternalStore(subscribeToConnection, environmentsSnapshot);
  const target = star === undefined ? undefined : starTarget(star);
  const [options] = useState(() => ({
    ...starComposerOptions(starId),
    timelineHeader: {
      element: document.createElement("div"),
      content: (
        <Suspense fallback={null}>
          <StarFold starId={starId} />
        </Suspense>
      ),
    },
  }));
  // The view's mount: a new generation for a new target, but for the thread the draft became, which the view shows already.
  const mount = useRef<{ target: StarTarget | undefined; generation: number; promoted?: { environmentId: string; threadId: string } }>({
    target: undefined,
    generation: 0,
  });
  if (target !== undefined && !sameTarget(target, mount.current.target)) {
    const { promoted, generation, target: shown } = mount.current;
    // The store may bring the thread before the view names it, or after.
    const adopted =
      target.kind === "thread" &&
      ((promoted?.environmentId === target.environmentId && promoted.threadId === target.threadId) ||
        (shown?.kind === "draft" && draftCreates(shown, target.environmentId, target.threadId)));
    mount.current = { target, generation: adopted ? generation : generation + 1 };
  }
  if (star === undefined) return <div className="pult-thread-empty">Reading your Star…</div>;
  if (target === undefined) {
    return <div className="pult-thread-empty">Not connected to your Star's environment. Run “Pult: Connect to Environment”.</div>;
  }
  const paneTarget: PaneTarget = target;
  return (
    <ThreadContent
      target={paneTarget}
      generation={mount.current.generation}
      onPromoted={(environmentId, threadId) => {
        mount.current.promoted = { environmentId, threadId };
      }}
      options={options}
      barEntries={(bar) => <StarBarEntries bar={bar} target={target} />}
    />
  );
}

/**
 * The Star's place in its composer bar, as a thread's is
 * (`src/threads/barEntries.tsx`) but for Source Control, which a Star's
 * folder has none of: Explorer, narrowed to the Star's folder, and while a
 * conversation runs its environment, which a sleeping Star's draft picks
 * with upstream's own environment picker instead.
 */
function StarBarEntries({ bar, target }: { bar: HTMLElement; target: StarTarget }) {
  const state = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const held = state.environments.find((candidate) => candidate.id === target.environmentId);
  const environment =
    target.kind === "draft" || held === undefined ? null : `Environment: ${held.label}${held.name === held.label ? "" : ` (${held.name})`}`;
  const run = (command: string) => void getService(ICommandService).then((commands) => commands.executeCommand(command));
  return (
    <>
      {createPortal(
        <div data-chat-composer-slot-item="shell" className="pult-bar-entries">
          <BarTip label="Explorer">
            <button type="button" className="pult-bar-entry pult-bar-button" aria-label="Explorer" onClick={() => run("pult-shell.openThreadExplorer")}>
              <i className="codicon codicon-files" aria-hidden />
            </button>
          </BarTip>
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
