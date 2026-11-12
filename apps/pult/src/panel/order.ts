import type { ProjectDraft } from "../../view/drafts.ts";
import { scopedKey, type ShelfName, type ShellThread } from "../threads/store.ts";

/** The Pult tab's shelves, every one closable, in the panel's default order. */
export const PANEL_SHELVES = [
  "stars",
  "explorer",
  "inbox",
  "working",
  "snoozed",
  "settled",
  "limits",
] as const;

export type PanelShelf = (typeof PANEL_SHELVES)[number];

/** The top shelves: the leading run of them in the panel's order sticks to its top (`lowerShelves`). */
const TOP_SHELVES: ReadonlySet<PanelShelf> = new Set(["stars", "explorer", "inbox"]);

/**
 * Where each shelf is: in the panel's open shelves, top to bottom, or the
 * tray's closed ones, left to right; each shelf in exactly one. Opening or
 * closing a shelf appends it to the end of the other (`openIn`, `closeIn`).
 */
export interface ShelfOrder {
  readonly open: ReadonlyArray<PanelShelf>;
  readonly closed: ReadonlyArray<PanelShelf>;
}

export const DEFAULT_SHELF_ORDER: ShelfOrder = { open: PANEL_SHELVES, closed: [] };

/** The order with `shelf` opened, at the panel's bottom; an open one stays where it is. */
export function openIn(order: ShelfOrder, shelf: PanelShelf): ShelfOrder {
  if (order.open.includes(shelf)) return order;
  return { open: [...order.open, shelf], closed: order.closed.filter((each) => each !== shelf) };
}

/** The order with `shelf` closed, at the tray's end, or at `at` among the closed; a closed one stays where it is. */
export function closeIn(
  order: ShelfOrder,
  shelf: PanelShelf,
  at: number = order.closed.length,
): ShelfOrder {
  if (order.closed.includes(shelf)) return order;
  return {
    open: order.open.filter((each) => each !== shelf),
    closed: order.closed.toSpliced(at, 0, shelf),
  };
}

/**
 * The order with `shelf` dragged into `list`, just before `before`, or at its
 * end while `before` is null; the order itself when that is where it already is.
 */
export function moveIn(
  order: ShelfOrder,
  shelf: PanelShelf,
  list: keyof ShelfOrder,
  before: PanelShelf | null,
): ShelfOrder {
  if (before === shelf) return order;
  const rest = {
    open: order.open.filter((each) => each !== shelf),
    closed: order.closed.filter((each) => each !== shelf),
  };
  const at = before === null ? -1 : rest[list].indexOf(before);
  const next = {
    ...rest,
    [list]: rest[list].toSpliced(at === -1 ? rest[list].length : at, 0, shelf),
  };
  const same = (a: ReadonlyArray<PanelShelf>, b: ReadonlyArray<PanelShelf>) =>
    a.length === b.length && a.every((each, index) => each === b[index]);
  return same(next.open, order.open) && same(next.closed, order.closed) ? order : next;
}

/** A stored order, or null when it is not one: every shelf exactly once across the two lists. */
export function parseShelfOrder(stored: unknown): ShelfOrder | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { open, closed } = stored as Record<string, unknown>;
  if (!Array.isArray(open) || !Array.isArray(closed)) return null;
  const all: unknown[] = [...open, ...closed];
  const complete =
    all.length === PANEL_SHELVES.length && PANEL_SHELVES.every((shelf) => all.includes(shelf));
  return complete ? { open: open as PanelShelf[], closed: closed as PanelShelf[] } : null;
}

/**
 * The open shelves after the leading run of top shelves, which stick to the
 * panel's bottom: the first of them that renders takes the free space above
 * it (`panel.css`), so an empty one, left out, does not take it.
 */
export function lowerShelves(open: ReadonlyArray<PanelShelf>): ReadonlyArray<PanelShelf> {
  const run = open.findIndex((shelf) => !TOP_SHELVES.has(shelf));
  return run === -1 ? [] : open.slice(run);
}

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

/**
 * The Explorer shelf's rows: each environment's, its open files under it,
 * then the files of no held environment. With one environment held it has no
 * row, the shelf's header standing for it, its files still nested under it.
 */
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
  const several = environmentIds.length > 1;
  return [
    ...environmentIds.flatMap((environmentId) => [
      ...(several
        ? [{ kind: "environment" as const, key: environmentKey(environmentId), environmentId }]
        : []),
      ...files
        .filter((file) => ofEnvironment(file, environmentId))
        .map((file) => fileEntry(file, true)),
    ]),
    ...files
      .filter((file) => !environmentIds.some((environmentId) => ofEnvironment(file, environmentId)))
      .map((file) => fileEntry(file, false)),
  ];
}

/**
 * Inbox's draft cards: the drafts of held environments with something in
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
  /** The Stars' cards, by their Stars' ids; none while Show Star is off. */
  readonly stars: ReadonlyArray<string>;
  readonly environmentIds: ReadonlyArray<string>;
  /** The Explorer shelf's open files. */
  readonly files: ReadonlyArray<File>;
  /** Inbox's draft cards (`draftCards`). */
  readonly drafts: ReadonlyArray<ProjectDraft>;
  /** The store's threads, in its order. */
  readonly threads: ReadonlyArray<Thread>;
  /** The key of the selected card: a thread's, its root's for a subagent, or a draft's. */
  readonly selection: string | undefined;
  /** The open shelves, in the panel's order; a closed one's rows none is reached. */
  readonly open: ReadonlyArray<PanelShelf>;
  /** How many settled threads the settled shelf's tail shows. */
  readonly settledCount: number;
}

/**
 * The panel's rows Cmd+1 to Cmd+9 reach, top to bottom as the panel shows
 * them (`PanelView.tsx`), as upstream's sidebar jumps reach its visible
 * rows: shelf by shelf in the open shelves' order, a closed shelf reaching
 * none; the Stars' cards, the Explorer shelf's open files, its environments'
 * rows left out, and the cards, Inbox's drafts and threads and the Working,
 * Snoozed and Settled shelves', the threads none while no environment is held.
 * The Limits shelf's rows are none: they select nothing.
 */
export function jumpTargets<File extends FileRef, Thread extends ThreadRef>(
  panel: PanelRows<File, Thread>,
): JumpTarget<File, Thread>[] {
  const on = (...shelves: ReadonlyArray<ShelfName>) =>
    panel.environmentIds.length === 0
      ? []
      : panel.threads.filter((thread) => thread.shelf !== null && shelves.includes(thread.shelf));
  const threadTarget = (thread: Thread): JumpTarget<File, Thread> => ({
    kind: "thread",
    key: keyOf(thread),
    thread,
  });
  const rows = (shelf: PanelShelf): JumpTarget<File, Thread>[] => {
    switch (shelf) {
      case "stars":
        return panel.stars.map((starId) => ({ kind: "star", key: starKey(starId), starId }));
      case "explorer":
        return explorerEntries(panel.environmentIds, panel.files).flatMap(
          (entry): JumpTarget<File, Thread>[] =>
            entry.kind === "file" ? [{ kind: "file", key: entry.key, file: entry.file }] : [],
        );
      case "inbox":
        return [
          ...panel.drafts.map((draft): JumpTarget<File, Thread> => ({
            kind: "draft",
            key: draftKey(draft),
            draft,
          })),
          ...on("pinned", "active").map(threadTarget),
        ];
      case "working":
      case "snoozed":
        return on(shelf).map(threadTarget);
      case "settled":
        return settledTail(on("settled"), panel.settledCount, panel.selection).map(threadTarget);
      case "limits":
        return [];
    }
  };
  return panel.open.flatMap(rows);
}
