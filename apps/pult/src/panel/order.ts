import type { ProjectDraft } from "../../view/drafts.ts";
import { scopedKey, type ShelfName, type ShellThread } from "../threads/store.ts";

/** Upstream's settled tail: this many settled threads at first, then a page more per click. */
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;

/** A thread's identity across environments (`scopedKey`), which the selection and the panel's maps go by. */
export const keyOf = (thread: Pick<ShellThread, "environmentId" | "id">) =>
  scopedKey(thread.environmentId, thread.id);

/** A draft card's key, beside the threads' in the selection's snapshot. */
export const draftKey = (draft: Pick<ProjectDraft, "environmentId" | "projectId">) =>
  `draft:${scopedKey(draft.environmentId, draft.projectId)}`;

export const environmentKey = (environmentId: string) => `environment:${environmentId}`;

/** A Star's card's key, beside the threads' in the selection's snapshot. */
export const starKey = (starId: string) => `star:${starId}`;

/** What the panel's order needs of a thread. */
type ThreadRef = Pick<ShellThread, "environmentId" | "id" | "shelf">;

/** What the Explorer shelf needs of a file's URI. */
export interface FileRef {
  readonly scheme: string;
  readonly authority: string;
  toString(): string;
}

/** A row of the Explorer shelf: an environment, or an open file, `nested` under its environment's row. */
export type ExplorerEntry<File extends FileRef> =
  | { readonly kind: "environment"; readonly key: string; readonly environmentId: string }
  | { readonly kind: "file"; readonly key: string; readonly file: File; readonly nested: boolean };

/** The Explorer shelf's rows: each environment's, its open files under it, then the files of no held environment. */
export function explorerEntries<File extends FileRef>(
  environmentIds: ReadonlyArray<string>,
  files: ReadonlyArray<File>,
): ExplorerEntry<File>[] {
  const ofEnvironment = (file: File, environmentId: string) =>
    file.scheme === "pult" && file.authority.toLowerCase() === environmentId.toLowerCase();
  const fileEntry = (file: File, nested: boolean): ExplorerEntry<File> => ({
    kind: "file",
    key: file.toString(),
    file,
    nested,
  });
  return [
    ...environmentIds.flatMap((environmentId) => [
      { kind: "environment" as const, key: environmentKey(environmentId), environmentId },
      ...files
        .filter((file) => ofEnvironment(file, environmentId))
        .map((file) => fileEntry(file, true)),
    ]),
    ...files
      .filter((file) => !environmentIds.some((environmentId) => ofEnvironment(file, environmentId)))
      .map((file) => fileEntry(file, false)),
  ];
}

/** What a collapsible list shows: everything while `expanded`, else the selected item alone, if it is one of them. */
export function shown<Item>(
  items: ReadonlyArray<Item>,
  expanded: boolean,
  isSelected: (item: Item) => boolean,
): ReadonlyArray<Item> {
  if (expanded) return items;
  const selected = items.find(isSelected);
  return selected === undefined ? [] : [selected];
}

/**
 * Ready's draft cards: the drafts of held environments with something in
 * them, newest first, and the `selected` one even while empty, first; none
 * of a Star's project (`isStars`), whose draft is the Star's own.
 */
export function draftCards(
  drafts: ReadonlyArray<ProjectDraft>,
  selected: Pick<ProjectDraft, "environmentId" | "projectId"> | undefined,
  environmentIds: ReadonlySet<string>,
  isStars: (draft: Pick<ProjectDraft, "environmentId" | "projectId">) => boolean = () => false,
): ReadonlyArray<ProjectDraft> {
  const held = drafts.filter((draft) => environmentIds.has(draft.environmentId) && !isStars(draft));
  if (selected === undefined || !environmentIds.has(selected.environmentId)) return held;
  if (held.some((draft) => draftKey(draft) === draftKey(selected))) return held;
  return [
    {
      environmentId: selected.environmentId,
      projectId: selected.projectId,
      preview: "",
      createdAt: "",
    },
    ...held,
  ];
}

/** The settled shelf's tail: its first `count` threads, and the `selection`'s even when it lies beyond. */
export function settledTail<Thread extends ThreadRef>(
  threads: ReadonlyArray<Thread>,
  count: number,
  selection: string | undefined,
): Thread[] {
  const visible = threads.slice(0, count);
  const beyond = threads.slice(count).find((thread) => keyOf(thread) === selection);
  if (beyond !== undefined) visible.push(beyond);
  return visible;
}

/** A row of the left panel that Cmd+1 to Cmd+9 reach: a Star's card, an open file of the Explorer shelf, a draft card or a thread card. */
export type JumpTarget<File extends FileRef, Thread extends ThreadRef = ShellThread> =
  | { readonly kind: "star"; readonly key: string; readonly starId: string }
  | { readonly kind: "file"; readonly key: string; readonly file: File }
  | { readonly kind: "draft"; readonly key: string; readonly draft: ProjectDraft }
  | { readonly kind: "thread"; readonly key: string; readonly thread: Thread };

/** What the panel shows, as `jumpTargets` reads it. */
export interface PanelRows<File extends FileRef, Thread extends ThreadRef = ShellThread> {
  /** The Stars' cards, first, by their Stars' ids; none while Show Star is off. */
  readonly stars: ReadonlyArray<string>;
  readonly environmentIds: ReadonlyArray<string>;
  readonly explorer: {
    readonly files: ReadonlyArray<File>;
    /** The key of the row the Explorer shelf highlights, which it shows while collapsed. */
    readonly highlighted: string | undefined;
    readonly expanded: boolean;
  };
  /** Ready's draft cards (`draftCards`). */
  readonly drafts: ReadonlyArray<ProjectDraft>;
  /** The store's threads, in its order. */
  readonly threads: ReadonlyArray<Thread>;
  /** The key of the selected card: a thread's, its root's for a subagent, or a draft's. */
  readonly selection: string | undefined;
  readonly expanded: Readonly<Record<"ready" | Exclude<ShelfName, "pinned" | "active">, boolean>>;
  /** How many settled threads the settled shelf's tail shows. */
  readonly settledCount: number;
}

/**
 * The panel's rows Cmd+1 to Cmd+9 reach, top to bottom as the panel shows
 * them (`PanelView.tsx`), as upstream's sidebar jumps reach its visible
 * rows: the Stars' cards first, then the Explorer shelf's open files, its
 * environments' rows left out, then the cards, Ready's drafts and threads,
 * and the Working, Snoozed and Settled shelves'; a collapsed list reaches
 * its selected row alone. The Limits shelf's
 * rows, last, are none: they select nothing.
 */
export function jumpTargets<File extends FileRef, Thread extends ThreadRef>(
  panel: PanelRows<File, Thread>,
): JumpTarget<File, Thread>[] {
  const isHighlighted = (entry: ExplorerEntry<File>) => entry.key === panel.explorer.highlighted;
  const stars = panel.stars.map((starId): JumpTarget<File, Thread> => ({
    kind: "star",
    key: starKey(starId),
    starId,
  }));
  const files = [
    ...stars,
    ...shown(
      explorerEntries(panel.environmentIds, panel.explorer.files),
      panel.explorer.expanded,
      isHighlighted,
    ).flatMap((entry): JumpTarget<File, Thread>[] =>
      entry.kind === "file" ? [{ kind: "file", key: entry.key, file: entry.file }] : [],
    ),
  ];
  if (panel.environmentIds.length === 0) return files;
  const on = (...shelves: ReadonlyArray<ShelfName>) =>
    panel.threads.filter((thread) => thread.shelf !== null && shelves.includes(thread.shelf));
  const threadTarget = (thread: Thread): JumpTarget<File, Thread> => ({
    kind: "thread",
    key: keyOf(thread),
    thread,
  });
  const isSelected = (target: JumpTarget<File, Thread>) => target.key === panel.selection;
  const ready: JumpTarget<File, Thread>[] = [
    ...panel.drafts.map((draft): JumpTarget<File, Thread> => ({
      kind: "draft",
      key: draftKey(draft),
      draft,
    })),
    ...on("pinned", "active").map(threadTarget),
  ];
  return [
    ...files,
    ...shown(ready, panel.expanded.ready, isSelected),
    ...shown(on("working").map(threadTarget), panel.expanded.working, isSelected),
    ...shown(on("snoozed").map(threadTarget), panel.expanded.snoozed, isSelected),
    ...shown(
      settledTail(on("settled"), panel.settledCount, panel.selection).map(threadTarget),
      panel.expanded.settled,
      isSelected,
    ),
  ];
}
