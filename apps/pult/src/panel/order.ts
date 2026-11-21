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

/**
 * The two groups a shelf belongs to, for good: the top shelves stick to the
 * panel's top and close into the tray in the Pult tab's header, the bottom
 * ones stick to its bottom and close into the tray under the panel.
 */
export type ShelfGroup = "top" | "bottom";

const TOP_SHELVES: ReadonlySet<PanelShelf> = new Set(["stars", "explorer", "inbox"]);

export const groupOf = (shelf: PanelShelf): ShelfGroup =>
  TOP_SHELVES.has(shelf) ? "top" : "bottom";

/**
 * Where each shelf is: in the panel's open shelves, top to bottom, the top
 * group's before the bottom group's, or the trays' closed ones, left to
 * right, each tray showing its group's; each shelf in exactly one. Closing a
 * shelf appends it to the closed ones' end, opening one puts it at the end
 * of its group in the panel (`openIn`, `closeIn`).
 */
export interface ShelfOrder {
  readonly open: ReadonlyArray<PanelShelf>;
  readonly closed: ReadonlyArray<PanelShelf>;
}

export const DEFAULT_SHELF_ORDER: ShelfOrder = { open: PANEL_SHELVES, closed: [] };

/** The open shelves with `shelf` put at `at`, moved within its group's run where `at` lies outside it. */
function placeOpen(
  open: ReadonlyArray<PanelShelf>,
  shelf: PanelShelf,
  at: number,
): ReadonlyArray<PanelShelf> {
  const tops = open.filter((each) => groupOf(each) === "top").length;
  const [start, end] = groupOf(shelf) === "top" ? [0, tops] : [tops, open.length];
  return open.toSpliced(Math.min(Math.max(at, start), end), 0, shelf);
}

/** The order with `shelf` opened at the end of its group in the panel; an open one stays where it is. */
export function openIn(order: ShelfOrder, shelf: PanelShelf): ShelfOrder {
  if (order.open.includes(shelf)) return order;
  return {
    open: placeOpen(order.open, shelf, order.open.length),
    closed: order.closed.filter((each) => each !== shelf),
  };
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
 * end while `before` is null, among the open ones kept within its group's run
 * (`placeOpen`); the order itself when that is where it already is.
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
  const found = before === null ? -1 : rest[list].indexOf(before);
  const at = found === -1 ? rest[list].length : found;
  const next = {
    ...rest,
    [list]: list === "open" ? placeOpen(rest.open, shelf, at) : rest.closed.toSpliced(at, 0, shelf),
  };
  const same = (a: ReadonlyArray<PanelShelf>, b: ReadonlyArray<PanelShelf>) =>
    a.length === b.length && a.every((each, index) => each === b[index]);
  return same(next.open, order.open) && same(next.closed, order.closed) ? order : next;
}

/**
 * A stored order, or null when it is not one: every shelf exactly once
 * across the two lists. The open ones come back top group first, as an order
 * stored before the groups were fixed may not have them.
 */
export function parseShelfOrder(stored: unknown): ShelfOrder | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { open, closed } = stored as Record<string, unknown>;
  if (!Array.isArray(open) || !Array.isArray(closed)) return null;
  const all: unknown[] = [...open, ...closed];
  const complete =
    all.length === PANEL_SHELVES.length && PANEL_SHELVES.every((shelf) => all.includes(shelf));
  if (!complete) return null;
  const shelves = open as PanelShelf[];
  return {
    open: [
      ...shelves.filter((shelf) => groupOf(shelf) === "top"),
      ...shelves.filter((shelf) => groupOf(shelf) === "bottom"),
    ],
    closed: closed as PanelShelf[],
  };
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

/** An ask's row: its environment and id, and the shelf its status puts it on (`src/asks/asks.ts`). */
export interface AskRef {
  readonly environmentId: string;
  readonly id: string;
  readonly shelf: "inbox" | "working" | "snoozed" | "settled";
}

/** An ask's row's key, beside the cards' in the jump hints. */
export const askKey = (ask: Pick<AskRef, "environmentId" | "id">) =>
  `ask:${ask.environmentId}/${ask.id}`;

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

/** A row of the left panel that Cmd+1 to Cmd+9 reach: a Star's card, an open file of the Explorer shelf, a draft card, an ask's row or a thread card. */
export type JumpTarget<File extends FileRef, Thread extends ThreadRef = ShellThread> =
  | { readonly kind: "star"; readonly key: string; readonly starId: string }
  | { readonly kind: "file"; readonly key: string; readonly file: File }
  | { readonly kind: "draft"; readonly key: string; readonly draft: ProjectDraft }
  | { readonly kind: "ask"; readonly key: string; readonly ask: AskRef }
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
  /** The asks' rows, each on its shelf, in the model's order (`shownAsks`, `src/asks/asks.ts`). */
  readonly asks: ReadonlyArray<AskRef>;
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
 * rows left out, Inbox's rows (`inboxRows`), and the ask rows then the cards
 * of the Working, Snoozed and Settled shelves', the threads none while no
 * environment is held.
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
  const asksOn = (shelf: AskRef["shelf"]) =>
    panel.asks
      .filter((ask) => ask.shelf === shelf)
      .map((ask): JumpTarget<File, Thread> => ({ kind: "ask", key: askKey(ask), ask }));
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
        return inboxRows(panel);
      case "working":
      case "snoozed":
        return [...asksOn(shelf), ...on(shelf).map(threadTarget)];
      case "settled":
        return [
          ...asksOn("settled"),
          ...settledTail(on("settled"), panel.settledCount, panel.selection).map(threadTarget),
        ];
      case "limits":
        return [];
    }
  };
  return panel.open.flatMap(rows);
}

/**
 * Inbox's rows, top to bottom: the draft cards, then the posted asks' rows,
 * then the pinned and active threads' cards, none while no environment is held.
 */
export function inboxRows<File extends FileRef, Thread extends ThreadRef>(
  panel: Pick<PanelRows<File, Thread>, "drafts" | "asks" | "threads" | "environmentIds">,
): JumpTarget<File, Thread>[] {
  return [
    ...panel.drafts.map((draft): JumpTarget<File, Thread> => ({
      kind: "draft",
      key: draftKey(draft),
      draft,
    })),
    ...panel.asks
      .filter((ask) => ask.shelf === "inbox")
      .map((ask): JumpTarget<File, Thread> => ({ kind: "ask", key: askKey(ask), ask })),
    ...(panel.environmentIds.length === 0
      ? []
      : panel.threads.filter((thread) => thread.shelf === "pinned" || thread.shelf === "active")
    ).map((thread): JumpTarget<File, Thread> => ({ kind: "thread", key: keyOf(thread), thread })),
  ];
}
