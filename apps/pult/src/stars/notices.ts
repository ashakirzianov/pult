// What the shell tells the user outside the page (monore
// `pult/tasks/notify-outside-the-page.task`; `pult/decisions`,
// `notifications`), apart from the DOM so `node --test
// src/stars/notices.test.ts` can run it: the dock badge's count, the
// extensions' Inbox rows (an ask's among them) whoever posted them and the
// secrets agents wait for, and which rows, secrets and Stars' waits are new
// since the page last looked. `notify.ts` shows them.
import type { LookThread } from "./look.ts";
import { starLook } from "./look.ts";
import { threadsBelow } from "./stars.ts";

/** A Star as the notices read it: the panel's Stars, none while Show Star is off. */
export interface NoticeStar {
  readonly id: string;
  /** As the UI names it (`starName`). */
  readonly name: string;
  /** The thread it waits on while its look is waiting, null while it is not; undefined until every ready home is current and its threads are in. `card`: the thread waits on a secret, whose notice stands in for the Star's, or on a card not yet read. */
  readonly waitingOn:
    | { readonly title: string; readonly card?: "secret" | "unread" }
    | null
    | undefined;
}

/** An environment's extension rows on Inbox as the panel shows them, `current` while it is ready and its rows are this connect's (`answeredOn`, `src/extensions/ui.ts`). */
export interface NoticeRows {
  readonly environmentId: string;
  readonly current: boolean;
  /** Each by its extension and key, with its poster as the row names it (`posterName`) and its status's time, which moving later asks again. */
  readonly posted: ReadonlyArray<{
    readonly extension: string;
    readonly key: string;
    readonly title: string;
    readonly poster: string;
    readonly since: string | null;
  }>;
}

/** An environment's secrets as Inbox shows them (`src/secrets/`), `current` while it is ready and its threads are in. */
export interface NoticeSecrets {
  readonly environmentId: string;
  readonly current: boolean;
  /** Each by its `cardKey`, with its label and its poster as the row names it (`posterName`). */
  readonly posted: ReadonlyArray<{
    readonly key: string;
    readonly threadId: string;
    readonly label: string;
    readonly poster: string;
  }>;
  /** The waiting cards not yet read, by `cardKey`: a secret's or not. */
  readonly unread: ReadonlyArray<string>;
}

/** What the page has seen: per environment its Inbox rows with their status's time and the secrets' keys, and per Star whether it waits. */
export interface Seen {
  readonly rows: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waiting: ReadonlyMap<string, boolean>;
}

export const NOTHING_SEEN: Seen = { rows: new Map(), secrets: new Map(), waiting: new Map() };

/** A notification to show: `tag` names it, so a second with that tag replaces it and `live` tells when it goes. */
export type Notice =
  | {
      readonly kind: "row";
      readonly tag: string;
      readonly environmentId: string;
      readonly extension: string;
      readonly key: string;
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly kind: "secret";
      readonly tag: string;
      readonly environmentId: string;
      readonly threadId: string;
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly kind: "waiting";
      readonly tag: string;
      readonly starId: string;
      readonly title: string;
      readonly body: string;
    };

export interface Notices {
  readonly seen: Seen;
  /** The dock's number: the extensions' rows and the secrets, Inbox's. */
  readonly badge: number;
  /** What became new since `seen`. */
  readonly show: ReadonlyArray<Notice>;
  /** The tags whose notification may stay: a row still on Inbox or a secret still posted, or of an environment not current, a Star not known to have stopped waiting nor to wait on a secret. */
  readonly live: ReadonlySet<string>;
}

const rowId = (row: { readonly extension: string; readonly key: string }) =>
  JSON.stringify([row.extension, row.key]);
const rowTag = (environmentId: string, id: string) => `pult-row:${environmentId}:${id}`;
const secretTag = (key: string) => `pult-secret:${key}`;
const waitingTag = (starId: string) => `pult-waiting:${starId}`;

/**
 * The badge and what is new. An extension's row is new when it is on Inbox
 * on a current environment whose last current answer did not have it there,
 * or had it with an earlier status time: an ask new, asked again or back
 * from a snooze. An environment's first answer
 * after it connects, and a Star's first reading once its threads are in, are
 * a baseline and notify nothing, so a reconnect or a reload replays nothing:
 * an environment not current, and a Star whose wait is unknown, are
 * forgotten, and keep their notifications.
 *
 * A secret is new as a row is, once its card is read: a card unread in the
 * baseline counts as seen until it is read. A Star waiting on a secret
 * notifies nothing, the secret's notice standing in for it, and on a card
 * not yet read keeps what was known of its wait until it is.
 */
export function notices(
  stars: ReadonlyArray<NoticeStar>,
  rows: ReadonlyArray<NoticeRows>,
  secrets: ReadonlyArray<NoticeSecrets>,
  seen: Seen,
): Notices {
  const posted = new Map<string, ReadonlyMap<string, string | null>>();
  const secretsSeen = new Map<string, ReadonlySet<string>>();
  const waiting = new Map<string, boolean>();
  const show: Notice[] = [];
  const live = new Set<string>();
  let badge = 0;
  for (const environment of rows) {
    badge += environment.posted.length;
    for (const row of environment.posted) live.add(rowTag(environment.environmentId, rowId(row)));
    const before = seen.rows.get(environment.environmentId);
    if (!environment.current) {
      for (const id of before?.keys() ?? []) live.add(rowTag(environment.environmentId, id));
      continue;
    }
    posted.set(
      environment.environmentId,
      new Map(environment.posted.map((row) => [rowId(row), row.since] as const)),
    );
    if (before === undefined) continue;
    for (const row of environment.posted) {
      const id = rowId(row);
      const was = before.get(id);
      if (before.has(id) && (row.since === null || (was ?? "") >= row.since)) continue;
      show.push({
        kind: "row",
        tag: rowTag(environment.environmentId, id),
        environmentId: environment.environmentId,
        extension: row.extension,
        key: row.key,
        title: row.poster,
        body: row.title,
      });
    }
  }
  for (const environment of secrets) {
    badge += environment.posted.length;
    for (const secret of environment.posted) live.add(secretTag(secret.key));
    const before = seen.secrets.get(environment.environmentId);
    if (!environment.current) {
      for (const key of before ?? []) live.add(secretTag(key));
      continue;
    }
    secretsSeen.set(
      environment.environmentId,
      new Set([
        ...environment.posted.map((secret) => secret.key),
        ...environment.unread.filter((key) => before === undefined || before.has(key)),
      ]),
    );
    if (before === undefined) continue;
    for (const secret of environment.posted)
      if (!before.has(secret.key))
        show.push({
          kind: "secret",
          tag: secretTag(secret.key),
          environmentId: environment.environmentId,
          threadId: secret.threadId,
          title: secret.label,
          body: `${secret.poster} asks for a secret`,
        });
  }
  for (const star of stars) {
    if (star.waitingOn !== null && star.waitingOn?.card !== "secret") live.add(waitingTag(star.id));
    if (star.waitingOn === undefined) continue;
    const was = seen.waiting.get(star.id);
    if (star.waitingOn?.card === "unread") {
      if (was !== undefined) waiting.set(star.id, was);
      continue;
    }
    waiting.set(star.id, star.waitingOn !== null);
    if (star.waitingOn !== null && star.waitingOn.card !== "secret" && was === false)
      show.push({
        kind: "waiting",
        tag: waitingTag(star.id),
        starId: star.id,
        title: star.name,
        body: `Waiting for you: ${star.waitingOn.title}`,
      });
  }
  return { seen: { rows: posted, secrets: secretsSeen, waiting }, badge, show, live };
}

/**
 * The thread a Star waits on while its look is waiting (`starLook`), each
 * channel read from `threads`, the store's live rows, the Stars' own rows
 * changing only with their signature: an open conversation awaiting the
 * user, else a thread below one; null while it does not wait.
 */
export function waitingThread<Thread extends LookThread & { readonly title: string }>(
  star: { readonly channels: ReadonlyArray<{ readonly thread: Thread }> },
  threads: ReadonlyArray<Thread>,
): Thread | null {
  const live = (thread: Thread) =>
    threads.find((each) => each.environmentId === thread.environmentId && each.id === thread.id) ??
    thread;
  const channels = star.channels.map(({ thread }) => ({ thread: live(thread) }));
  if (starLook({ channels }, threads) !== "waiting") return null;
  const awaiting = channels.find(({ thread }) => thread.awaitsUser)?.thread;
  if (awaiting !== undefined) return awaiting;
  const below = channels.flatMap(({ thread }) => threadsBelow(thread, threads));
  const found = below.find((each) => each.awaitsUser);
  if (found === undefined) throw new Error("a waiting Star with no thread awaiting the user");
  return found;
}
