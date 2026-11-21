import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import markUrl from "../../assets/pult/mark.svg?no-inline";
import { selectionSnapshot } from "../panel/jump.ts";
import { keyOf } from "../panel/order.ts";
import { subagentsByRoot, threadActivities, useMinuteClock } from "../panel/PanelView.tsx";
import { StarMark } from "../panel/StarCard.tsx";
import { starLookOf, starMarks, tintColor } from "../stars/mark.ts";
import { starStore } from "../stars/model.ts";
import { cardRows, drawnHome, type Star, starName } from "../stars/stars.ts";
import { projectIconUri, threadProjectIcon, useProjectIcons } from "../threads/projectIcon.ts";
import {
  explorerSelected,
  onDidSelectThread,
  selectedDraft,
  selectedStar,
  selectedThread,
} from "../threads/selection.ts";
import { isSubagent, type ShellThread, threadStore } from "../threads/store.ts";
import type { DetailsColumn } from "../../view/main.tsx";
import { detailsColumn } from "./column.ts";
import { StarDetails } from "./StarDetails.tsx";

const subscribeToThreads = (listener: () => void) => threadStore.subscribe(listener);
const threadsSnapshot = () => threadStore.get();

/** What the column shows details of: the selection, as the panel's cards follow it. */
type Subject =
  | { readonly kind: "star"; readonly star: Star }
  | { readonly kind: "thread"; readonly thread: ShellThread }
  | { readonly kind: "draft"; readonly environmentId: string; readonly projectId: string }
  | { readonly kind: "explorer" }
  | { readonly kind: "none" };

/**
 * The selection's subject, re-rendering on its change: a Star, selected or
 * through a subagent of its current conversation, as its card stays
 * selected then (`PanelView.tsx`); a thread the store holds; a draft; the
 * Explorer workspace; or nothing (no selection yet, a thread not yet in).
 */
function useSubject(): Subject {
  useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  const { threads } = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const stars = useSyncExternalStore(starStore.subscribe, starStore.get);
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

/**
 * The column's title row, after its 35px: the selection's mark or icon and
 * its name, a Star's live mark and name, a thread's project's icon and its
 * title, a draft's project's icon and "New thread", Pult's mark and
 * "Explorer" for the Explorer workspace; nothing with no selection.
 */
export function DetailsTitle() {
  const subject = useSubject();
  const marks = useSyncExternalStore(starMarks.subscribe, starMarks.get);
  useProjectIcons();
  switch (subject.kind) {
    case "star":
      return (
        <>
          <StarMark
            look={starLookOf(subject.star, marks)}
            color={tintColor(subject.star.tint, marks.scheme)}
          />
          <span className="pult-details-name">{starName(subject.star)}</span>
        </>
      );
    case "thread":
      return (
        <>
          <img
            className="pult-details-icon"
            src={projectIconUri(threadProjectIcon(subject.thread)).toString(true)}
            alt=""
          />
          <span className="pult-details-name">{subject.thread.title}</span>
        </>
      );
    case "draft": {
      const { environmentId, projectId } = subject;
      const project = threadStore.project(environmentId, projectId);
      return (
        <>
          <img
            className="pult-details-icon"
            src={projectIconUri(
              project ?? {
                environmentId,
                name: "Project",
                root: null,
                icon: null,
                faviconPath: null,
              },
            ).toString(true)}
            alt=""
          />
          <span className="pult-details-name">New thread</span>
        </>
      );
    }
    case "explorer":
      return (
        <>
          <span
            className="pult-details-icon pult-details-mark"
            style={{ maskImage: `url("${markUrl}")` }}
            aria-hidden
          />
          <span className="pult-details-name">Explorer</span>
        </>
      );
    case "none":
      return null;
  }
}

/**
 * The element upstream's thread details render into for the selected thread
 * or draft, from the pane's view showing it (`view/ThreadDetailsCard.tsx`):
 * one of the view's roots (`pult-view-theme`), so its stylesheet, its
 * shortcuts and its text sizes reach it.
 */
function ThreadDetailsColumn({ subject }: { subject: DetailsColumn["subject"] }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const key = JSON.stringify(subject);
  useLayoutEffect(() => {
    if (element === null) return;
    detailsColumn.set({ element, subject: JSON.parse(key) });
    return () => detailsColumn.set(null);
  }, [element, key]);
  return <div ref={setElement} className="pult-details-thread pult-view-theme" />;
}

/**
 * The Details view's body: a Star's details (`StarDetails.tsx`), from the
 * same rows its card held; a thread's or a draft's, upstream's rows
 * (`ThreadDetailsColumn`); for the Explorer workspace, one muted line.
 */
export function DetailsView() {
  const subject = useSubject();
  const { threads, environments } = useSyncExternalStore(subscribeToThreads, threadsSnapshot);
  const now = useMinuteClock();
  const selection = useSyncExternalStore(onDidSelectThread, selectionSnapshot);
  if (subject.kind === "thread" || subject.kind === "draft")
    return (
      <div className="pult-panel pult-details">
        <ThreadDetailsColumn
          subject={
            subject.kind === "thread"
              ? {
                  kind: "thread",
                  environmentId: subject.thread.environmentId,
                  threadId: subject.thread.id,
                }
              : subject
          }
        />
      </div>
    );
  if (subject.kind !== "star")
    return (
      <div className="pult-panel pult-details">
        {subject.kind === "none" ? null : <p className="pult-details-empty">Nothing to show</p>}
      </div>
    );
  const { star } = subject;
  const activities = threadActivities(threads);
  const conversation = star.current === null ? undefined : keyOf(star.current);
  const subagents =
    conversation === undefined
      ? []
      : (subagentsByRoot(threads, activities).get(conversation) ?? []);
  const environmentId = drawnHome(star)?.environmentId;
  return (
    <div className="pult-panel pult-details">
      <StarDetails
        key={star.id}
        star={star}
        environment={environments.find((environment) => environment.id === environmentId)?.name}
        rows={cardRows(star, threads)}
        subagents={subagents}
        activities={activities}
        selection={selection}
        now={now}
      />
    </div>
  );
}
