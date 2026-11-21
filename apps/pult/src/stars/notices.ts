// What the shell tells the user outside the page (xaxis
// `pult/issues/notify-outside-the-page.md`; `pult/decisions`,
// `notifications`), apart from the DOM so `node --test
// src/stars/notices.test.ts` can run it: the dock badge's count, the posted
// asks whoever posted them and the secrets agents wait for, and which asks,
// secrets and Stars' waits are new since the page last looked. `notify.ts` shows them.
import type { LookInputs, LookThread } from "./look.ts";
import { starLook } from "./look.ts";
import { type StarHome, threadsBelow } from "./stars.ts";

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

/** An environment's posted asks as the panel shows them, `current` while it is ready and its answer is this connect's (`asksAnsweredOn`). */
export interface NoticeAsks {
  readonly environmentId: string;
  readonly current: boolean;
  /** Each with its poster as the row names it (`posterName`). */
  readonly posted: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly poster: string;
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

/** What the page has seen: per environment the posted asks' ids and the secrets' keys, and per Star whether it waits. */
export interface Seen {
  readonly asks: ReadonlyMap<string, ReadonlySet<string>>;
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waiting: ReadonlyMap<string, boolean>;
}

export const NOTHING_SEEN: Seen = { asks: new Map(), secrets: new Map(), waiting: new Map() };

/** A notification to show: `tag` names it, so a second with that tag replaces it and `live` tells when it goes. */
export type Notice =
  | {
      readonly kind: "ask";
      readonly tag: string;
      readonly environmentId: string;
      readonly ask: string;
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
  /** The dock's number: the posted asks and the secrets, Inbox's. */
  readonly badge: number;
  /** What became new since `seen`. */
  readonly show: ReadonlyArray<Notice>;
  /** The tags whose notification may stay: an ask or a secret still posted, or of an environment not current, a Star not known to have stopped waiting nor to wait on a secret. */
  readonly live: ReadonlySet<string>;
}

const askTag = (environmentId: string, ask: string) => `pult-ask:${environmentId}:${ask}`;
const secretTag = (key: string) => `pult-secret:${key}`;
const waitingTag = (starId: string) => `pult-waiting:${starId}`;

/**
 * The badge and what is new. An ask is new when it is posted on a current
 * environment whose last current answer did not have it posted: a new one,
 * or one asked again or back from a snooze. An environment's first answer
 * after it connects, and a Star's first reading once its threads are in, are
 * a baseline and notify nothing, so a reconnect or a reload replays nothing:
 * an environment not current, and a Star whose wait is unknown, are
 * forgotten, and keep their notifications.
 *
 * A secret is new as an ask is, once its card is read: a card unread in the
 * baseline counts as seen until it is read. A Star waiting on a secret
 * notifies nothing, the secret's notice standing in for it, and on a card
 * not yet read keeps what was known of its wait until it is.
 */
export function notices(
  stars: ReadonlyArray<NoticeStar>,
  asks: ReadonlyArray<NoticeAsks>,
  secrets: ReadonlyArray<NoticeSecrets>,
  seen: Seen,
): Notices {
  const posted = new Map<string, ReadonlySet<string>>();
  const secretsSeen = new Map<string, ReadonlySet<string>>();
  const waiting = new Map<string, boolean>();
  const show: Notice[] = [];
  const live = new Set<string>();
  let badge = 0;
  for (const environment of asks) {
    badge += environment.posted.length;
    for (const ask of environment.posted) live.add(askTag(environment.environmentId, ask.id));
    if (!environment.current) {
      for (const tag of seen.asks.get(environment.environmentId) ?? [])
        live.add(askTag(environment.environmentId, tag));
      continue;
    }
    const before = seen.asks.get(environment.environmentId);
    posted.set(environment.environmentId, new Set(environment.posted.map((ask) => ask.id)));
    if (before === undefined) continue;
    for (const ask of environment.posted)
      if (!before.has(ask.id))
        show.push({
          kind: "ask",
          tag: askTag(environment.environmentId, ask.id),
          environmentId: environment.environmentId,
          ask: ask.id,
          title: ask.poster,
          body: ask.title,
        });
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
  return { seen: { asks: posted, secrets: secretsSeen, waiting }, badge, show, live };
}

/**
 * The thread a Star waits on while its look is waiting (`starLook`), each
 * channel read from `threads`, the store's live rows, the Stars' own rows
 * changing only with their signature: an open conversation awaiting the
 * user, else a thread below one; null while it does not wait.
 */
export function waitingThread<Thread extends LookThread & { readonly title: string }>(
  star: {
    readonly channels: ReadonlyArray<{ readonly thread: Thread }>;
    readonly homes: ReadonlyArray<Pick<StarHome, "environmentId" | "projectId">>;
  },
  threads: ReadonlyArray<Thread>,
): Thread | null {
  const live = (thread: Thread) =>
    threads.find((each) => each.environmentId === thread.environmentId && each.id === thread.id) ??
    thread;
  const channels = star.channels.map(({ thread }) => ({ thread: live(thread) }));
  const inputs: LookInputs = { threads, unsent: new Set(), drafts: [], now: 0 };
  if (starLook({ channels, homes: star.homes }, inputs) !== "waiting") return null;
  const awaiting = channels.find(({ thread }) => thread.awaitsUser)?.thread;
  if (awaiting !== undefined) return awaiting;
  const below = channels.flatMap(({ thread }) => threadsBelow(thread, threads));
  const found = below.find((each) => each.awaitsUser);
  if (found === undefined) throw new Error("a waiting Star with no thread awaiting the user");
  return found;
}
