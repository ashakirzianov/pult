import { useSyncExternalStore } from "react";

import { selectionSnapshot } from "../panel/jump.ts";
import { subagentsByRoot, threadActivities, useMinuteClock } from "../panel/PanelView.tsx";
import { starStore } from "../stars/model.ts";
import { cardRows, type Star } from "../stars/stars.ts";
import {
  explorerSelected,
  onDidSelectThread,
  selectedDraft,
  selectedStar,
  selectedThread,
} from "../threads/selection.ts";
import { isSubagent, type ShellThread, threadStore } from "../threads/store.ts";
import { detailsCards } from "./cards.ts";
import { StarDetails } from "./StarDetails.tsx";
import { ThreadDetails } from "./ThreadDetails.tsx";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** What the cards show details of: the selection, as the panel's cards follow it. */
export type Subject =
  | { readonly kind: "star"; readonly star: Star }
  | { readonly kind: "thread"; readonly thread: ShellThread }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string }
  | { readonly kind: "explorer" }
  | { readonly kind: "none" };

/**
 * The selection's subject: a Star, selected or through a subagent of its
 * current conversation, as its square stays selected then (`PanelView.tsx`);
 * a thread the store holds; a draft; the Explorer workspace; or nothing (no
 * selection yet, a thread not yet in).
 */
export function detailsSubject(): Subject {
  const { threads } = threadStore.get();
  const stars = starStore.get();
  if (explorerSelected()) return { kind: "explorer" };
  const starId = selectedStar();
  if (starId !== undefined) {
    const star = stars.find((candidate) => candidate.id === starId);
    return star === undefined ? { kind: "none" } : { kind: "star", star };
  }
  const draft = selectedDraft();
  if (draft !== undefined) return { kind: "draft", ...draft };
  const selection = selectedThread();
  const thread = threads.find(
    (candidate) =>
      candidate.id === selection?.threadId && candidate.environmentId === selection.environmentId,
  );
  if (thread === undefined) return { kind: "none" };
  if (isSubagent(thread)) {
    const star = stars.find(
      (candidate) =>
        candidate.current?.environmentId === thread.environmentId &&
        candidate.current.id === thread.rootId,
    );
    if (star !== undefined) return { kind: "star", star };
  }
  return { kind: "thread", thread };
}

/** What the selected Star's details and tray draw from, the same rows its card held; null while the selection is no Star. */
export function useStarDetails() {
  const { threads } = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  useSyncExternalStore(starStore.subscribe, starStore.get);
  const now = useMinuteClock();
  // Read through `detailsSubject`, which a change of selection changes.
  useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const subject = detailsSubject();
  if (subject.kind !== "star") return null;
  const { star } = subject;
  const activities = threadActivities(threads);
  return {
    star,
    rows: cardRows(star, threads),
    subagentsOf: subagentsByRoot(threads, activities),
    threads,
    activities,
    now,
  };
}

/** The selected Star's details (`StarDetails.tsx`); nothing while the selection is no Star. */
function StarCards() {
  const details = useStarDetails();
  return details === null ? null : <StarDetails key={details.star.id} {...details} />;
}

/**
 * The details the cards show (`detailsCards`), rendered by the shell into the
 * element the thread view floats them in, or the file's column
 * (`index.tsx`, `filePanel.tsx`): a Star's, or a thread's or a draft's
 * (`ThreadDetails.tsx`); nothing while they show none.
 */
export function DetailsShelves() {
  const subject = useSyncExternalStore(detailsCards.subscribe, detailsCards.get)?.subject;
  if (subject === undefined) return null;
  if (subject.kind === "star") return <StarCards />;
  return <ThreadDetails key={JSON.stringify(subject)} subject={subject} />;
}
