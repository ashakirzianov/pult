// The Stars as the page draws them, apart from the workbench so
// `node --test src/stars/stars.test.ts` can run it: each environment's
// answer of the Pult plugin's `stars` route merged by id into Stars, each
// with its homes and its current conversation's live row; and when the page
// asks for a Star to be created.
import type { ShellThread } from "../threads/store.ts";
import type { RouteConversation, RouteSchedule, StarsAnswer } from "./plugin.ts";

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
  /** Its current conversation on this environment, as the plugin reads it; null while it sleeps here. */
  readonly conversation: RouteConversation | null;
  /** Since when it sleeps here: its last conversation's settlement, else its creation. */
  readonly asleepSince: string;
  /** The transcripts' names of this environment, oldest first. */
  readonly conversations: ReadonlyArray<string>;
  /** Its schedules as this environment's plugin read them (`schedules.ts`). */
  readonly schedules: ReadonlyArray<RouteSchedule>;
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

/** Asleep while it has no current conversation, Working while that conversation's run is on, else Awake. */
export type StarState = "asleep" | "awake" | "working";

/**
 * A Star: a record id with its homes, one per environment whose plugin
 * serves it; its current conversation, the page's live row of the thread
 * a home's plugin names, while the page holds it open; and since when it
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
  readonly current: Thread | null;
  readonly asleepSince: string;
  readonly state: StarState;
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
 * The home a Star is drawn from, for the fold and the card's schedules
 * (and the asks to come): the home of its current conversation, else the one
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
 * tint are its first home's. Its current conversation is the live row of a
 * thread a home's plugin names as current, while the page's threads hold it
 * open, the newest by creation where several homes name one; asleep
 * otherwise, as the plugin says it is or as the page has just seen it
 * settle, until its next answer.
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
        conversation: star.conversation,
        asleepSince: star.asleepSince,
        conversations: star.conversations,
        schedules: star.schedules,
        ...(origin === undefined ? {} : { origin }),
      });
    }
  }
  return [...byId.values()].map(({ first, origin, homes }) => {
    const current =
      newestFirst(
        homes.flatMap((home) => {
          const threadId = home.conversation?.threadId;
          const thread = threads.find(
            (each) =>
              each.environmentId === home.environmentId && each.id === threadId && !each.settled,
          );
          return thread === undefined ? [] : [thread];
        }),
      )[0] ?? null;
    const star = { homes, current };
    return {
      id: first.id,
      name: first.name,
      tint: first.tint,
      created: first.created,
      ...(origin === undefined ? {} : { origin }),
      homes,
      current,
      asleepSince: drawnHome(star)?.asleepSince ?? first.created,
      state: current === null ? "asleep" : current.working ? "working" : "awake",
    };
  });
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
