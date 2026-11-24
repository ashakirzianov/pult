import type { ProjectDraft } from "../../view/drafts.ts";
import { scopedKey, type ShelfName, type ShellThread } from "../threads/store.ts";

/** The Pult tab's shelves, every one closable, in the panel's default order. */
export const PANEL_SHELVES = [
  "stars",
  "explorer",
  "inbox",
  "working",
  "snoozed",
  "limits",
  "settled",
] as const;

export type PanelShelf = (typeof PANEL_SHELVES)[number];

export type ShelfGroup = "top" | "bottom";

/** The panel's order, with closed shelves keeping their place in their group. */
export interface ShelfOrder<Name extends string = PanelShelf> {
  readonly top: ReadonlyArray<Name>;
  readonly bottom: ReadonlyArray<Name>;
  readonly closed: ReadonlyArray<Name>;
}

export const DEFAULT_SHELF_ORDER: ShelfOrder = { top: PANEL_SHELVES, bottom: [], closed: [] };

export function openIn<Name extends string>(
  order: ShelfOrder<Name>,
  shelf: Name,
): ShelfOrder<Name> {
  if (!order.closed.includes(shelf)) return order;
  return { ...order, closed: order.closed.filter((each) => each !== shelf) };
}

export function closeIn<Name extends string>(
  order: ShelfOrder<Name>,
  shelf: Name,
): ShelfOrder<Name> {
  if (order.closed.includes(shelf)) return order;
  return { ...order, closed: [...order.closed, shelf] };
}

export function openShelves<Name extends string>(
  order: ShelfOrder<Name>,
  group: ShelfGroup,
): Name[] {
  return order[group].filter((shelf) => !order.closed.includes(shelf));
}

export function closedShelves<Name extends string>(order: ShelfOrder<Name>): Name[] {
  return [...order.top, ...order.bottom].filter((shelf) => order.closed.includes(shelf));
}

export function groupOf<Name extends string>(order: ShelfOrder<Name>, shelf: Name): ShelfGroup {
  return order.top.includes(shelf) ? "top" : "bottom";
}

/** Move relative to a shelf in the destination group, or append when there is no anchor. */
export function moveIn<Name extends string>(
  order: ShelfOrder<Name>,
  shelf: Name,
  group: ShelfGroup,
  anchor: Name | null = null,
  after = false,
): ShelfOrder<Name> {
  if (anchor === shelf) return order;
  const source = groupOf(order, shelf);
  const rest = order[group].filter((each) => each !== shelf);
  const at = anchor === null ? rest.length : rest.indexOf(anchor) + Number(after);
  if (source === group && order[group][at] === shelf) return order;
  return {
    ...order,
    [source]: order[source].filter((each) => each !== shelf),
    [group]: rest.toSpliced(at, 0, shelf),
  };
}

/** Read the current or immediately preceding storage format, appending newly added shelves. */
export function parseShelfOrder<Name extends string>(
  stored: unknown,
  names: ReadonlyArray<Name>,
): ShelfOrder<Name> | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { top, bottom, open, closed } = stored as Record<string, unknown>;
  if (!Array.isArray(closed)) return null;
  const groups =
    Array.isArray(top) && Array.isArray(bottom)
      ? { top, bottom }
      : Array.isArray(open)
        ? { top: [...open, ...closed], bottom: [] }
        : null;
  if (groups === null) return null;
  const all: unknown[] = [...groups.top, ...groups.bottom];
  const valid =
    all.length > 0 &&
    new Set(all).size === all.length &&
    all.every((shelf) => names.includes(shelf as Name)) &&
    new Set(closed).size === closed.length &&
    closed.every((shelf) => all.includes(shelf));
  if (!valid) return null;
  return {
    top: [...(groups.top as Name[]), ...names.filter((shelf) => !all.includes(shelf))],
    bottom: groups.bottom as Name[],
    closed: closed as Name[],
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

/** A Star's square's key, beside the threads' in the selection's snapshot. */
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

/** A secret's row: its thread, in its environment, and its card's turn item (`src/secrets/secrets.ts`). */
export interface SecretRef {
  readonly environmentId: string;
  readonly threadId: string;
  readonly id: string;
}

/** A secret's row's key, beside the cards' in the jump hints. */
export const secretKey = (secret: SecretRef) =>
  `secret:${secret.environmentId}/${secret.threadId}/${secret.id}`;

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

/** A row of the left panel that Cmd+1 to Cmd+9 reach: a Star's square, an open file of the Explorer shelf, a draft card, a secret's row, an ask's row or a thread card. */
export type JumpTarget<File extends FileRef, Thread extends ThreadRef = ShellThread> =
  | { readonly kind: "star"; readonly key: string; readonly starId: string }
  | { readonly kind: "file"; readonly key: string; readonly file: File }
  | { readonly kind: "draft"; readonly key: string; readonly draft: ProjectDraft }
  | { readonly kind: "secret"; readonly key: string; readonly secret: SecretRef }
  | { readonly kind: "ask"; readonly key: string; readonly ask: AskRef }
  | { readonly kind: "thread"; readonly key: string; readonly thread: Thread };

/** What the panel shows, as `jumpTargets` reads it. */
export interface PanelRows<File extends FileRef, Thread extends ThreadRef = ShellThread> {
  /** The Stars' squares, by their Stars' ids; none while Show Star is off. */
  readonly stars: ReadonlyArray<string>;
  readonly environmentIds: ReadonlyArray<string>;
  /** The Explorer shelf's open files. */
  readonly files: ReadonlyArray<File>;
  /** Inbox's draft cards (`draftCards`). */
  readonly drafts: ReadonlyArray<ProjectDraft>;
  /** The secrets' rows, in the model's order, all in Inbox (`src/secrets/`). */
  readonly secrets: ReadonlyArray<SecretRef>;
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
 * none; the Stars' squares, the Explorer shelf's open files, its environments'
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
 * Inbox's rows, top to bottom, which the panel draws, counts and jumps to:
 * the draft cards, then the secrets' rows, then the posted asks' rows, then
 * the pinned and active threads' cards, none while no environment is held.
 */
export function inboxRows<File extends FileRef, Thread extends ThreadRef>(
  panel: Pick<
    PanelRows<File, Thread>,
    "drafts" | "secrets" | "asks" | "threads" | "environmentIds"
  >,
): JumpTarget<File, Thread>[] {
  return [
    ...panel.drafts.map((draft): JumpTarget<File, Thread> => ({
      kind: "draft",
      key: draftKey(draft),
      draft,
    })),
    ...panel.secrets.map((secret): JumpTarget<File, Thread> => ({
      kind: "secret",
      key: secretKey(secret),
      secret,
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
