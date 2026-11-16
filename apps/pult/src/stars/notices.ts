// What the shell tells the user outside the page about the Stars (xaxis
// `pult/issues/notify-outside-the-page.md`; `pult/decisions`,
// `notifications`), apart from the DOM so `node --test
// src/stars/notices.test.ts` can run it: the dock badge's count, and which
// asks and waits are new since the page last looked. `notify.ts` shows them.
import type { LookInputs, LookThread } from "./look.ts";
import { starLook } from "./look.ts";
import { type StarHome, threadsBelow } from "./stars.ts";

/** A Star as the notices read it: the panel's Stars, none while Show Star is off. */
export interface NoticeStar {
  readonly id: string;
  /** As the UI names it (`starName`). */
  readonly name: string;
  /** Each home's asks, `current` while its environment is ready and its answer is this connect's (`starsAnsweredOn`). */
  readonly homes: ReadonlyArray<{
    readonly environmentId: string;
    readonly current: boolean;
    readonly asks: ReadonlyArray<{ readonly name: string; readonly title: string }>;
  }>;
  /** The environment of the home it is drawn from (`drawnHome`), whose asks its card counts and opens. */
  readonly drawn: string | undefined;
  /** The thread it waits on while its look is waiting, null while it is not; undefined until every ready home is current and its threads are in. */
  readonly waitingOn: { readonly title: string } | null | undefined;
}

/** What the page has seen: per Star and home the ask names; per Star the asks it was told of, and whether it waits. */
export interface Seen {
  readonly asks: ReadonlyMap<string, ReadonlySet<string>>;
  readonly told: ReadonlyMap<string, ReadonlySet<string>>;
  readonly waiting: ReadonlyMap<string, boolean>;
}

export const NOTHING_SEEN: Seen = { asks: new Map(), told: new Map(), waiting: new Map() };

/** A notification to show: `tag` names it, so a second with that tag replaces it and `live` tells when it goes. */
export type Notice =
  | {
      readonly kind: "ask";
      readonly tag: string;
      readonly starId: string;
      readonly ask: string;
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
  /** The dock's number: the sum of the cards' asks. */
  readonly badge: number;
  /** What became new since `seen`. */
  readonly show: ReadonlyArray<Notice>;
  /** The tags whose notification may stay: an ask some home still holds, a Star not known to have stopped waiting. */
  readonly live: ReadonlySet<string>;
}

const askTag = (starId: string, ask: string) => `pult-ask:${starId}:${ask}`;
const waitingTag = (starId: string) => `pult-waiting:${starId}`;
const homeKey = (starId: string, environmentId: string) => `${starId}\n${environmentId}`;

/**
 * The badge and what is new. An ask is new when it appears on the home the
 * Star is drawn from, as its card shows it, and the page has not told of
 * it already, so the sync bringing it to another home tells nothing. A
 * home's first answer after its environment connects, and a Star's first
 * reading once its threads are in, are a baseline and notify nothing, so a
 * reconnect or a reload replays nothing: a home not current, and a Star
 * whose wait is unknown, are forgotten.
 */
export function notices(stars: ReadonlyArray<NoticeStar>, seen: Seen): Notices {
  const asks = new Map<string, ReadonlySet<string>>();
  const told = new Map<string, ReadonlySet<string>>();
  const waiting = new Map<string, boolean>();
  const show: Notice[] = [];
  const live = new Set<string>();
  let badge = 0;
  for (const star of stars) {
    const anywhere = new Set(star.homes.flatMap((home) => home.asks.map((ask) => ask.name)));
    for (const name of anywhere) live.add(askTag(star.id, name));
    for (const home of star.homes) {
      if (home.current)
        asks.set(homeKey(star.id, home.environmentId), new Set(home.asks.map((ask) => ask.name)));
    }
    const drawn = star.homes.find((home) => home.environmentId === star.drawn);
    badge += drawn?.asks.length ?? 0;
    const known = new Set([...(seen.told.get(star.id) ?? [])].filter((name) => anywhere.has(name)));
    if (drawn?.current === true) {
      const before = seen.asks.get(homeKey(star.id, drawn.environmentId));
      for (const ask of drawn.asks) {
        if (before !== undefined && !before.has(ask.name) && !known.has(ask.name))
          show.push({
            kind: "ask",
            tag: askTag(star.id, ask.name),
            starId: star.id,
            ask: ask.name,
            title: star.name,
            body: ask.title,
          });
        known.add(ask.name);
      }
    }
    told.set(star.id, known);
    if (star.waitingOn !== null) live.add(waitingTag(star.id));
    if (star.waitingOn === undefined) continue;
    waiting.set(star.id, star.waitingOn !== null);
    if (star.waitingOn !== null && seen.waiting.get(star.id) === false)
      show.push({
        kind: "waiting",
        tag: waitingTag(star.id),
        starId: star.id,
        title: star.name,
        body: `Waiting for you: ${star.waitingOn.title}`,
      });
  }
  return { seen: { asks, told, waiting }, badge, show, live };
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
