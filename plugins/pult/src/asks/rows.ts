// The asks as rows on the page's thread shelves (`host.ui`, the `shelf-row` slot), a click opening
// an ask's page with a reply composer the asks handle. Built whole at activation, the next snooze end
// or expiry and a thread poster's event, a target read per poster; a write rebuilds its row alone, and
// a write or event that may move a Star's conversation reads that poster's target again after it.
import {
  ActionRefused,
  type Composed,
  DateTime,
  Effect,
  type ExtensionHost,
  Semaphore,
  SendRefused,
  type SlotItem,
  Stream,
} from "../extension.ts";
import type { Action, Ask, Asks, AskStars, Poster } from "./asks.ts";

type Row = SlotItem<"shelf-row">;

const SHELVES = {
  posted: "inbox",
  replied: "working",
  snoozed: "snoozed",
  settled: "settled",
} as const satisfies Record<Ask["status"], Row["shelf"]>;

const SNOOZE = {
  id: "snooze",
  label: "Snooze",
  icon: "clock",
  input: { kind: "instant", label: "Snooze until" },
} as const;
const SETTLE = { id: "settle", label: "Settle", icon: "check", text: true } as const;
const WAKE = { id: "wake", label: "Wake", icon: "bell" } as const;
const UNSETTLE = { id: "unsettle", label: "Un-settle", icon: "discard" } as const;

/** How long a settled ask is kept after its settle, as `asks.ts` keeps it. */
const EXPIRY_MS = 7 * 24 * 60 * 60_000;

const millis = (at: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(at));

/** The status where a thread's sits, as the ask's card drew it: its icon, and its age or its snooze's end. */
function statusOf(ask: Ask): Row["status"] {
  switch (ask.status) {
    case "posted":
      return { icon: "comment-unresolved", label: "Ask", time: { at: ask.posted, as: "age" } };
    case "replied":
      return {
        icon: "comment",
        label: "Replied",
        time: { at: ask.replied ?? ask.posted, as: "age" },
      };
    case "snoozed":
      return {
        icon: "bell-slash",
        label: "Snoozed",
        ...(ask.snoozedUntil === null ? {} : { time: { at: ask.snoozedUntil, as: "clock" } }),
      };
    case "settled":
      return {
        icon: "check",
        label: "Settled",
        time: { at: ask.settled ?? ask.posted, as: "age" },
      };
  }
}

const actionsOf = (ask: Ask): Row["actions"] =>
  ask.status === "snoozed" ? [WAKE] : ask.status === "settled" ? [UNSETTLE] : [SNOOZE, SETTLE];

/** Where a poster's reply composer writes, undefined for a poster gone. */
type Target =
  | { readonly project: string; readonly model?: Composed["model"]; readonly note?: string }
  | undefined;

/** One key per poster: a Star's channel, or a thread. */
const posterKey = (poster: Poster) =>
  JSON.stringify("thread" in poster ? [poster.thread] : [poster.star, poster.channel]);

/** As `asks.ts` lists them. */
const byPosted = (left: Ask, right: Ask) =>
  left.posted.localeCompare(right.posted) || left.id.localeCompare(right.id);

/** The ask's row; `target` where its reply's composer writes. */
function rowOf(ask: Ask, target: Target): Row {
  // Offered while the posting is neither replied to nor settled.
  const chips =
    ask.replied === null && ask.settled === null
      ? ask.replies.map((text) => ({ label: text, text }))
      : [];
  return {
    key: ask.id,
    shelf: SHELVES[ask.status],
    title: ask.title,
    poster:
      "thread" in ask.poster
        ? { thread: ask.poster.thread }
        : {
            named: "star-mark",
            star: ask.poster.star,
            channel: ask.poster.channel,
            fallback: { icon: "account", label: "Star" },
          },
    status: statusOf(ask),
    actions: actionsOf(ask),
    open: {
      // Its page once it has one, the comments under its context.
      file: ask.page,
      ...(target === undefined
        ? {}
        : {
            reply: {
              target: {
                handled: {
                  project: target.project,
                  placeholder: "Write your reply",
                  ...(target.model === undefined ? {} : { model: target.model }),
                },
              },
              ...(target.note === undefined ? {} : { note: target.note }),
              chips,
            },
          }),
    },
  };
}

/** The action the row's button names; undefined for one asks do not have. */
function actionOf(action: string, value: string | undefined): Action | undefined {
  switch (action) {
    case "snooze":
      return value === undefined
        ? undefined
        : { kind: "snooze", until: DateTime.formatIso(DateTime.makeUnsafe(value)) };
    case "wake":
      return { kind: "snooze", until: null };
    case "settle":
      return { kind: "settle" };
    case "unsettle":
      return { kind: "unsettle" };
    default:
      return undefined;
  }
}

export interface AskRows {
  /**
   * The rows again after a write of the ask of `id`, its own rebuilt; with `moved`, for a write that
   * may have woken its poster's conversation, the poster's target is read again after. A failure is
   * logged, the page keeping the last.
   */
  readonly publish: (id: string, options: { readonly moved: boolean }) => Effect.Effect<void>;
}

export const make = Effect.fn("AskRows.make")(function* (
  host: ExtensionHost,
  stars: AskStars,
  asks: Asks,
) {
  const scope = yield* Effect.scope;
  const publishing = yield* Semaphore.make(1);
  /** The threads that posted asks, whose settles and removals move their rows. */
  let posterThreads = new Set<string>();
  /** Sleeping until the next ask changes by itself. */
  let timer: { readonly interruptUnsafe: () => void } | undefined;
  /** While a publish reads the asks: a poster's event then may concern a thread it has not counted yet. */
  let reading = false;

  /** The asks as last read, by id, and their posters' targets, by poster: what the rows are built from. */
  let built: { readonly asks: Map<string, Ask>; readonly targets: Map<string, Target> } | undefined;

  const targetOf = Effect.fn("AskRows.targetOf")(function* (poster: Poster) {
    if (!("thread" in poster)) return yield* stars.replyTarget(poster.star, poster.channel);
    const thread = yield* host.threads.get(poster.thread);
    return thread === null ? undefined : ({ project: thread.projectId } satisfies Target);
  });

  /** Publishes the rows as built, and sleeps until the next ask changes by itself. */
  const show = Effect.fn("AskRows.show")(function* (from: NonNullable<typeof built>) {
    const all = [...from.asks.values()].toSorted(byPosted);
    const posters = new Set(all.map((ask) => posterKey(ask.poster)));
    for (const key of from.targets.keys()) if (!posters.has(key)) from.targets.delete(key);
    posterThreads = new Set(
      all.flatMap((ask) => ("thread" in ask.poster ? [ask.poster.thread] : [])),
    );
    reading = false;
    yield* host.ui.publish(
      "shelf-row",
      all.map((ask) => {
        const key = posterKey(ask.poster);
        if (!from.targets.has(key))
          throw new Error(`unreachable: the ask ${ask.id}'s poster has no target read`);
        return rowOf(ask, from.targets.get(key));
      }),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const next = Math.min(
      ...all.flatMap((ask) =>
        ask.status === "snoozed" && ask.snoozedUntil !== null
          ? [millis(ask.snoozedUntil)]
          : ask.status === "settled" && ask.settled !== null
            ? [millis(ask.settled) + EXPIRY_MS]
            : [],
      ),
    );
    timer?.interruptUnsafe();
    timer = Number.isFinite(next)
      ? yield* Effect.forkDetach(
          Effect.sleep(Math.max(0, next - now) + 1000).pipe(
            // The fired timer is no longer the one to interrupt: its rebuild schedules the next.
            Effect.andThen(Effect.sync(() => void (timer = undefined))),
            Effect.andThen(rebuildLater),
          ),
        )
      : undefined;
  });

  /** One at a time, logged and dropped, the page keeping the last list; one failed or cut off drops what was built, so the next builds whole. */
  const oneAtATime = <E>(effect: Effect.Effect<void, E>): Effect.Effect<void> =>
    publishing
      .withPermits(1)(
        effect.pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success" ? Effect.void : Effect.sync(() => void (built = undefined)),
          ),
          Effect.ensuring(Effect.sync(() => void (reading = false))),
        ),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Pult could not publish the asks' rows.", { cause }),
        ),
      );

  /** Every ask read again, and each poster's target once. */
  const build = Effect.gen(function* () {
    reading = true;
    const all = yield* asks.list({ settled: true });
    const posters = new Map(all.map((ask) => [posterKey(ask.poster), ask.poster]));
    const targets = new Map(
      yield* Effect.forEach(
        posters,
        ([key, poster]) => Effect.map(targetOf(poster), (target) => [key, target] as const),
        { concurrency: 4 },
      ),
    );
    built = { asks: new Map(all.map((ask) => [ask.id, ask])), targets };
    yield* show(built);
  });
  const rebuild: Effect.Effect<void> = oneAtATime(build);
  const rebuildLater = Effect.suspend(() => rebuild);

  /** The poster's target read again, for its rows; nothing for a poster with none. */
  const refresh = (poster: Poster) =>
    oneAtATime(
      Effect.gen(function* () {
        const from = built;
        const key = posterKey(poster);
        if (from === undefined || !from.targets.has(key)) return;
        from.targets.set(key, yield* targetOf(poster));
        yield* show(from);
      }),
    );

  const publish: AskRows["publish"] = (id, { moved }) =>
    oneAtATime(
      Effect.gen(function* () {
        // Before the activation's build, a write's publish is that build.
        const from = built;
        if (from === undefined) return yield* build;
        reading = true;
        const ask = yield* asks.get(id);
        if (ask === undefined) from.asks.delete(id);
        else {
          const key = posterKey(ask.poster);
          // Every row of its poster takes this target. Read again after the answer, so it waits on no look.
          if (!from.targets.has(key)) from.targets.set(key, yield* targetOf(ask.poster));
          else if (moved) yield* Effect.forkIn(refresh(ask.poster), scope);
          from.asks.set(id, ask);
        }
        yield* show(from);
      }),
    );

  yield* Effect.addFinalizer(() => Effect.sync(() => timer?.interruptUnsafe()));

  yield* host.ui.onAction(({ key, action, value }) =>
    Effect.gen(function* () {
      const asked = actionOf(action, value);
      if (asked === undefined)
        return yield* new ActionRefused({ message: `Asks have no action "${action}".` });
      const done = yield* asks
        .act(key, asked)
        .pipe(Effect.mapError((error) => new ActionRefused({ message: error.message })));
      if (done === undefined)
        return yield* new ActionRefused({ message: "No ask has this id on this server." });
      if ("refused" in done) return yield* new ActionRefused({ message: done.refused });
      // A settle tells the poster, which may wake its conversation.
      yield* publish(key, { moved: asked.kind === "settle" });
    }),
  );

  yield* host.ui.onSend(({ key, message }) =>
    Effect.gen(function* () {
      const sent = yield* asks
        .reply(key, message)
        .pipe(Effect.mapError((error) => new SendRefused({ message: error.message })));
      if (sent === undefined)
        return yield* new SendRefused({ message: "No ask has this id on this server." });
      // The row moves to Working, without its chips, before the answer opens the thread.
      yield* publish(key, { moved: true });
      return sent;
    }),
  );

  /** The threads whose run's end was seen: a later run of one wakes no conversation. */
  const ran = new Set<string>();
  /** A Star's conversation settled, un-settled or gone, or its first run seen, perhaps a wake's: its channel's target read again. */
  const refreshStarOf = (threadId: string) =>
    Effect.flatMap(stars.posterOf(threadId), (own) =>
      own === undefined ? Effect.void : refresh(own),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Pult could not publish the asks' rows.", { cause }),
      ),
    );

  yield* Effect.forkScoped(
    Stream.runForEach(host.threadEvents, (event) => {
      // A run's end moves no thread poster's row. An event during a publish's read is published again after it, whatever thread it names.
      if (event._tag !== "run-completed" && (posterThreads.has(event.threadId) || reading))
        return rebuild;
      if (event._tag === "run-completed") {
        if (ran.has(event.threadId)) return Effect.void;
        ran.add(event.threadId);
      }
      return refreshStarOf(event.threadId);
    }),
  );
  yield* Effect.forkScoped(rebuild);
  return { publish } satisfies AskRows;
});
