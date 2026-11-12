// The Stars as the page draws them, apart from the workbench so
// `node --test src/stars/stars.test.ts` can run it: each environment's
// answer of the Pult plugin's `stars` route merged by id into Stars, each
// with its homes and its open channels' live rows; and when the page asks
// for a Star to be created.
import type { ShellThread } from "../threads/store.ts";
import {
  type RouteAsk,
  type RouteChannel,
  type RouteModel,
  type RouteSchedule,
  type StarsAnswer,
  USER_CHANNEL,
} from "./plugin.ts";

/** A Star's home: its folder and project on one environment, as that environment's plugin serves it. */
export interface StarHome {
  readonly environmentId: string;
  /** The environment's Stars directory, its Stars' repository (`syncing.ts`). */
  readonly directory: string;
  /** The folder's host path. */
  readonly root: string;
  readonly projectId: string;
  /** Its `instructions.md`, a host path. */
  readonly instructions: string;
  /** Its open channels on this environment, as the plugin reads them, by slug; none while it sleeps here. */
  readonly channels: ReadonlyArray<RouteChannel>;
  /** The model its next conversation with the user here takes, as this environment's plugin reads it (`RouteStar`'s). */
  readonly model: RouteModel | null;
  /** Since when `user` sleeps here: its last conversation's settlement, else the Star's creation. */
  readonly asleepSince: string;
  /** The names of `user`'s transcripts of this environment, oldest first. */
  readonly conversations: ReadonlyArray<string>;
  /** Its schedules as this environment's plugin read them (`schedules.ts`). */
  readonly schedules: ReadonlyArray<RouteSchedule>;
  /** Its asks as this environment's plugin read them, by name. */
  readonly asks: ReadonlyArray<RouteAsk>;
  /** Where the environment's Stars' repository syncs, its `origin`; absent while it does not (`sync.ts`). */
  readonly origin?: string;
}

/** What a Star reads of a thread of its projects. */
export type StarThread = Pick<
  ShellThread,
  | "environmentId"
  | "id"
  | "projectId"
  | "parentId"
  | "settled"
  | "settledAt"
  | "createdAt"
  | "working"
  | "workingSince"
  | "ageFrom"
>;

/** Asleep while no channel is open, Working while any open channel's run is on, else Awake. */
export type StarState = "asleep" | "awake" | "working";

/** An open channel of a Star's: its slug and its current conversation, the page's live row of the thread a home's plugin names. */
export interface StarChannel<Thread extends StarThread = ShellThread> {
  readonly slug: string;
  readonly thread: Thread;
}

/**
 * A Star: a record id with its homes, one per environment whose plugin
 * serves it; its open channels, each the page's live row of the thread a
 * home's plugin names, while the page holds it open; its current
 * conversation, `user`'s, the one its tab shows; and since when `user`
 * sleeps, by the home it is drawn from (`drawnHome`).
 */
export interface Star<Thread extends StarThread = ShellThread> {
  readonly id: string;
  readonly name: string;
  readonly tint: string;
  readonly created: string;
  /** Where it syncs, its first home's repository's origin; absent while it does not. */
  readonly origin?: string;
  readonly homes: ReadonlyArray<StarHome>;
  /** Every open channel whose conversation the page holds open, `user` among them, by slug. */
  readonly channels: ReadonlyArray<StarChannel<Thread>>;
  /** `user`'s open conversation; null while `user` sleeps, whatever the other channels do. */
  readonly current: Thread | null;
  readonly asleepSince: string;
  readonly state: StarState;
  /** The environments where a channel of its is open on its home there, whose conversations write in that environment's Stars' repository (`sync.ts`). */
  readonly awakeOn: ReadonlyArray<string>;
}

/** An environment's answer, as the model holds it, with its repository's origin. */
export interface EnvironmentAnswer {
  readonly environmentId: string;
  readonly answer: StarsAnswer;
  readonly origin?: string;
}

/** How the UI names a Star: its name, or "Star" while it has none. */
export function starName(star: Pick<Star<StarThread>, "name">): string {
  return star.name.trim() === "" ? "Star" : star.name;
}

const newestFirst = <Thread extends StarThread>(threads: ReadonlyArray<Thread>) =>
  threads.toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

/** The prefix of the tag that says a thread's channel, `pult:channel:<slug>` (`plugins/pult/src/stars/channels.ts`). */
const CHANNEL_TAG = "pult:channel:";
/** A channel's slug, as the plugin reads one: lowercase letters, digits and hyphens, starting with a letter or a digit, up to 51 characters. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,50}$/u;

/** A thread's first valid `pult:channel:<slug>` tag's slug, if it has one. */
function channelTag(thread: { readonly tags: ReadonlyArray<string> }): string | undefined {
  return thread.tags
    .filter((tag) => tag.startsWith(CHANNEL_TAG))
    .map((tag) => tag.slice(CHANNEL_TAG.length))
    .find((slug) => SLUG.test(slug));
}

/** The channel a conversation is, by its first valid `pult:channel:<slug>` tag; `user` where none is. */
export function channelOf(thread: { readonly tags: ReadonlyArray<string> }): string {
  return channelTag(thread) ?? USER_CHANNEL;
}

/** A Star's conversations among `threads`: the root threads of its homes' projects, newest first. */
export function conversationsOf<Thread extends StarThread>(
  homes: ReadonlyArray<Pick<StarHome, "environmentId" | "projectId">>,
  threads: ReadonlyArray<Thread>,
): Thread[] {
  return newestFirst(
    threads.filter(
      (thread) =>
        thread.parentId === null &&
        homes.some(
          (home) =>
            home.environmentId === thread.environmentId && home.projectId === thread.projectId,
        ),
    ),
  );
}

const later = (left: string, right: string) => Date.parse(right) > Date.parse(left);

/**
 * The home a Star is drawn from, for the fold and the card's asks and
 * schedules: the home of its current conversation, else the one
 * whose `asleepSince` is latest.
 */
export function drawnHome(star: Pick<Star<StarThread>, "homes" | "current">): StarHome | undefined {
  const current = star.homes.find((home) => home.environmentId === star.current?.environmentId);
  return (
    current ??
    star.homes.reduce<StarHome | undefined>(
      (latest, home) =>
        latest === undefined || later(latest.asleepSince, home.asleepSince) ? home : latest,
      undefined,
    )
  );
}

/**
 * The Stars of the environments' answers, in the order of their first home:
 * one id on several environments is one Star with a home on each. Name and
 * tint are its first home's. Each open channel's conversation is the live
 * row of the thread a home's plugin names for it, while the page's threads
 * hold it open, the newest by creation where several homes name one; a
 * channel sleeps otherwise, as the plugin says it does or as the page has
 * just seen its conversation settle, until its next answer. The Star is
 * asleep while no channel is open, Working while any open one works.
 */
export function starsOf<Thread extends StarThread>(
  answers: ReadonlyArray<EnvironmentAnswer>,
  threads: ReadonlyArray<Thread>,
): Star<Thread>[] {
  const byId = new Map<
    string,
    { first: StarsAnswer["stars"][number]; origin?: string; homes: StarHome[] }
  >();
  for (const { environmentId, answer, origin } of answers) {
    for (const star of answer.stars) {
      const entry = byId.get(star.id) ?? {
        first: star,
        ...(origin === undefined ? {} : { origin }),
        homes: [],
      };
      byId.set(star.id, entry);
      entry.homes.push({
        environmentId,
        directory: answer.directory,
        root: star.root,
        projectId: star.projectId,
        instructions: star.instructions,
        channels: star.channels,
        model: star.model,
        asleepSince: star.asleepSince,
        conversations: star.conversations,
        schedules: star.schedules,
        asks: star.asks,
        ...(origin === undefined ? {} : { origin }),
      });
    }
  }
  return [...byId.values()].map(({ first, origin, homes }) => {
    const open = new Map<string, Thread>();
    const live = homes.flatMap((home) =>
      home.channels.flatMap(({ slug, threadId }) => {
        const thread = threads.find(
          (each) =>
            each.environmentId === home.environmentId && each.id === threadId && !each.settled,
        );
        return thread === undefined ? [] : [{ slug, thread }];
      }),
    );
    for (const { slug, thread } of live.toSorted(
      (left, right) => Date.parse(right.thread.createdAt) - Date.parse(left.thread.createdAt),
    ))
      if (!open.has(slug)) open.set(slug, thread);
    const channels = [...open]
      .map(([slug, thread]) => ({ slug, thread }))
      .toSorted((left, right) => left.slug.localeCompare(right.slug));
    const current = open.get(USER_CHANNEL) ?? null;
    const star = { homes, current };
    return {
      id: first.id,
      name: first.name,
      tint: first.tint,
      created: first.created,
      ...(origin === undefined ? {} : { origin }),
      homes,
      channels,
      current,
      asleepSince: drawnHome(star)?.asleepSince ?? first.created,
      state:
        channels.length === 0
          ? "asleep"
          : channels.some(({ thread }) => thread.working)
            ? "working"
            : "awake",
      awakeOn: [...new Set(live.map(({ thread }) => thread.environmentId))],
    };
  });
}

/**
 * The rows under a selected Star's card: one per open channel but `user`,
 * whose conversation is the Star's tab, by slug.
 */
export function channelRows<Thread extends StarThread>(
  star: Pick<Star<Thread>, "channels">,
): ReadonlyArray<StarChannel<Thread>> {
  return star.channels.filter(({ slug }) => slug !== USER_CHANNEL);
}

/**
 * Of the tabs among the selected Star's (`StarThreadInput`), the one that
 * opening the channel `slug` on `current`, its open conversation, replaces:
 * none while a tab shows `current`, which is shown as it is; else a tab of
 * that channel on a conversation the page holds settled, a rotation having
 * left it behind, so the channel never has two tabs of one label (Anton's
 * ruling, 2026-11-12). A child's tab has no slug and is never one.
 */
export function rotatedChannelTab<
  Tab extends {
    readonly environmentId: string;
    readonly threadId: string;
    readonly slug: string | null;
  },
>(
  tabs: ReadonlyArray<Tab>,
  slug: string,
  current: { readonly environmentId: string; readonly id: string },
  threads: ReadonlyArray<Pick<StarThread, "environmentId" | "id" | "settled">>,
): Tab | undefined {
  const shows = (tab: Tab, thread: { readonly environmentId: string; readonly id: string }) =>
    tab.environmentId === thread.environmentId && tab.threadId === thread.id;
  if (tabs.some((tab) => shows(tab, current))) return undefined;
  return tabs.find(
    (tab) => tab.slug === slug && threads.some((thread) => thread.settled && shows(tab, thread)),
  );
}

/** The tag a Star gives every thread it launches, its child, before the Star's id (`star-launched-threads`). */
const CHILD_TAG = "pult:child:star:";
/** The channel a child's messages land in where it names none (`star-channels`). */
const WORK_CHANNEL = "work";

/** A row under a selected Star's card: a channel but `user`, its open conversation, null while it sleeps, and the Star's children of it, oldest first. */
export interface ChannelRow<Thread> {
  readonly slug: string;
  readonly thread: Thread | null;
  readonly children: ReadonlyArray<Thread>;
}

/** What a selected Star's card lists: `user`'s children, directly under it, then its channel rows. */
export interface CardRows<Thread> {
  readonly children: ReadonlyArray<Thread>;
  readonly channels: ReadonlyArray<ChannelRow<Thread>>;
}

/**
 * What a selected Star's card lists, as the page's threads have them now
 * (the Stars' model tells only a change of conversation or of its run): its
 * children, the unsettled threads tagged `pult:child:star:<id>` but its own
 * conversations, each under the row of its channel, its channel tag, `work`
 * with none, in the order they were created, `user`'s directly under the
 * card; and a row per open channel but `user`, its conversation's live row,
 * and per channel asleep with a child, reading Asleep, by slug.
 */
export function cardRows<Thread extends StarThread & Pick<ShellThread, "tags">>(
  star: Pick<Star<Thread>, "id" | "homes" | "channels">,
  threads: ReadonlyArray<Thread>,
): CardRows<Thread> {
  const conversations = new Set(conversationsOf(star.homes, threads));
  const children = threads
    .filter(
      (thread) =>
        thread.tags.includes(CHILD_TAG + star.id) && !thread.settled && !conversations.has(thread),
    )
    .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const childrenOf = (slug: string) =>
    children.filter((child) => (channelTag(child) ?? WORK_CHANNEL) === slug);
  const open = new Map(
    channelRows(star).map(({ slug, thread }) => {
      const live = threads.find(
        (each) => each.environmentId === thread.environmentId && each.id === thread.id,
      );
      return [slug, live === undefined || live.settled ? null : live];
    }),
  );
  const slugs = new Set([
    ...[...open].flatMap(([slug, thread]) => (thread === null ? [] : [slug])),
    ...children.map((child) => channelTag(child) ?? WORK_CHANNEL),
  ]);
  slugs.delete(USER_CHANNEL);
  return {
    children: childrenOf(USER_CHANNEL),
    channels: [...slugs]
      .toSorted((left, right) => left.localeCompare(right))
      .map((slug) => ({ slug, thread: open.get(slug) ?? null, children: childrenOf(slug) })),
  };
}

/** The threads below a conversation, its subagents' and theirs, as the store has them. */
export function threadsBelow<Thread extends Pick<ShellThread, "environmentId" | "id" | "rootId">>(
  thread: Pick<ShellThread, "environmentId" | "id">,
  threads: ReadonlyArray<Thread>,
): Thread[] {
  return threads.filter(
    (each) =>
      each.environmentId === thread.environmentId &&
      each.rootId === thread.id &&
      each.id !== thread.id,
  );
}

/** Whether a thread below the conversation works: a subagent thread's run holds the Star's look busy as the conversation's own does. */
export function lineageWorks(
  thread: Pick<ShellThread, "environmentId" | "id">,
  threads: ReadonlyArray<Pick<ShellThread, "environmentId" | "id" | "rootId" | "working">>,
): boolean {
  return threadsBelow(thread, threads).some((each) => each.working);
}

/**
 * The home a sleeping Star wakes in, where its draft's composer mounts: the
 * home it is drawn from, while its environment is held, else its first held
 * home.
 */
export function wakeHome(
  star: Pick<Star<StarThread>, "homes" | "current">,
  held: (environmentId: string) => boolean,
): StarHome | undefined {
  const drawn = drawnHome(star);
  return drawn !== undefined && held(drawn.environmentId)
    ? drawn
    : star.homes.find((home) => held(home.environmentId));
}

/** Which of the Stars a thread is the conversation of: a root thread of one of its homes' projects. */
export function findStarOfThread<Thread extends StarThread>(
  stars: ReadonlyArray<Star<Thread>>,
  thread: Pick<StarThread, "environmentId" | "projectId" | "parentId">,
): Star<Thread> | undefined {
  if (thread.parentId !== null) return undefined;
  return findStarOfProject(stars, thread.environmentId, thread.projectId);
}

/** The Star whose home `projectId` is, on `environmentId`. */
export function findStarOfProject<Thread extends StarThread>(
  stars: ReadonlyArray<Star<Thread>>,
  environmentId: string,
  projectId: string,
): Star<Thread> | undefined {
  return stars.find((star) =>
    star.homes.some((home) => home.environmentId === environmentId && home.projectId === projectId),
  );
}

/**
 * The transcripts that appeared in a home since the page's earlier answer
 * for it, by Star and environment: each is committed (`star-sync`). None
 * for a home the earlier answer lacked, the environment's first answer
 * among them: the sync on connect commits what is there.
 */
export function newTranscripts(
  earlier: StarsAnswer | undefined,
  next: StarsAnswer,
): Array<{ readonly starId: string; readonly names: ReadonlyArray<string> }> {
  if (earlier === undefined) return [];
  return next.stars.flatMap((star) => {
    const before = earlier.stars.find((each) => each.id === star.id);
    if (before === undefined) return [];
    const known = new Set(before.conversations);
    const names = star.conversations.filter((name) => !known.has(name));
    return names.length === 0 ? [] : [{ starId: star.id, names }];
  });
}

/** How the page stands with an environment's Stars, for the creation decision. */
export interface EnvironmentReading {
  readonly id: string;
  /** The connection's phase. */
  readonly phase: string;
  /** Whether the thread model has its projects. */
  readonly loaded: boolean;
  /**
   * Whether its Stars were read: pending until its plugin's `about` and,
   * where that lists `stars`, its first answer are in; none on a server
   * without the plugin, which can make no Star; failed where the answer
   * could not be read.
   */
  readonly read: "pending" | "read" | "none" | "failed";
  /** Whether the page asked for a Star on it since it last connected. */
  readonly attempted: boolean;
}

/**
 * The environment the page asks for a Star on by default, if any: only
 * while Show Star is on, the page holds no Star on any environment, every
 * environment has answered or failed, so a Star is never made beside one
 * still loading, no ready environment's Stars failed to read, since it may
 * hold the Star, and no creation failed since an environment last
 * connected (`halted`); then the first ready environment in the page's
 * order whose Stars were read, not tried since it last connected. An
 * environment without the plugin is passed over.
 */
export function creationTarget(input: {
  readonly enabled: boolean;
  /** Whether the page is restoring the environments saved before a reload. */
  readonly restoring: boolean;
  readonly halted: boolean;
  readonly stars: number;
  readonly environments: ReadonlyArray<EnvironmentReading>;
}): string | undefined {
  if (!input.enabled || input.restoring || input.halted || input.stars > 0) return undefined;
  const unsure = input.environments.some(
    (environment) =>
      environment.phase === "connecting" ||
      environment.phase === "reconnecting" ||
      (environment.phase === "ready" &&
        (environment.read === "pending" || environment.read === "failed" || !environment.loaded)),
  );
  if (unsure) return undefined;
  return input.environments.find(
    (environment) =>
      environment.phase === "ready" && environment.read === "read" && !environment.attempted,
  )?.id;
}
