import { useSyncExternalStore } from "react";

import { mountViewCard, runCommand, ViewFilterCard } from "../panel/filterCard.tsx";
import { type ProjectIconSource, projectIconUri, useProjectIcons } from "../threads/projectIcon.ts";

/** What the changes view's card shows: the thread the view is narrowed to, and what of its checkout it shows. */
export interface ChangesCardState {
  readonly project: ProjectIconSource;
  /** What the view shows of the checkout, its one group's label: "Working Tree" or "Changes". */
  readonly group: string;
  /** The turn the view shows instead, by its number. */
  readonly turn: number | null;
  readonly threadTitle: string;
  /** The thread's branch, shown under its title while no turn is; null for a thread with none. */
  readonly branch: string | null;
}

let state: ChangesCardState | undefined;
const listeners = new Set<() => void>();

const changesCard = {
  get: () => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The thread the changes view is narrowed to, or none: the card hides. */
export function setChangesCard(next: ChangesCardState | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * Source Control's filter while the changes view shows one thread's
 * checkout, as the Explorer tab's is: the project's icon, its name and what
 * the view shows of the checkout ("pult / Working Tree", "pult / Turn 5"),
 * then the thread's title and its branch; its clear mark is "Pult: Show All
 * Changes".
 */
function ChangesCard() {
  const card = useSyncExternalStore(changesCard.subscribe, changesCard.get);
  useProjectIcons();
  if (card === undefined) return null;
  return (
    <ViewFilterCard
      icon={<img className="pult-card-icon" src={projectIconUri(card.project).toString(true)} alt="" />}
      top={`${card.project.name} / ${card.turn === null ? card.group : `Turn ${card.turn}`}`}
      title={card.threadTitle}
      {...(card.branch === null || card.turn !== null ? {} : { detail: { codicon: "git-branch", text: card.branch } })}
      tooltip={card.turn === null ? "Only this thread's checkout" : `Only turn ${card.turn}'s changes`}
      clearTitle="Clear the filter: show every checkout's changes"
      onClear={() => runCommand("pult-shell.showAllChanges")}
    />
  );
}

/** The changes view's card above Source Control's tree. */
export function mountChangesCard(): Promise<void> {
  return mountViewCard("workbench.scm", ".part.sidebar .scm-view", <ChangesCard />);
}
