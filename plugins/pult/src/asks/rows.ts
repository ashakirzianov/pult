// The asks as rows on the page's thread shelves (`host.ui`, the `shelf-row` slot): one per ask on the
// shelf of its status, its actions as a thread card's, its click opening its file with a reply
// composer the asks handle. Published at activation and after every write, again at the next snooze
// end or expiry, and when a thread poster's thread settles, un-settles or goes (`threadEvents`).
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
import type { Action, Ask, Asks, AskStars } from "./asks.ts";

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

/** The ask's row; `target` where its reply's composer writes, undefined for a poster gone. */
function rowOf(
  ask: Ask,
  target:
    | { readonly project: string; readonly model?: Composed["model"]; readonly note?: string }
    | undefined,
): Row {
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
      file: ask.file,
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
  /** Every ask's row again, after a write; a failure is logged, the page keeping the last. */
  readonly publish: Effect.Effect<void>;
}

export const make = Effect.fn("AskRows.make")(function* (
  host: ExtensionHost,
  stars: AskStars,
  asks: Asks,
) {
  const publishing = yield* Semaphore.make(1);
  /** The threads that posted asks, whose settles and removals move their rows. */
  let posterThreads = new Set<string>();
  /** Sleeping until the next ask changes by itself. */
  let timer: { readonly interruptUnsafe: () => void } | undefined;

  const targetOf = (ask: Ask) =>
    "thread" in ask.poster
      ? Effect.map(host.threads.get(ask.poster.thread), (thread) =>
          thread === null ? undefined : { project: thread.projectId },
        )
      : stars.replyTarget(ask.poster.star, ask.poster.channel);

  const publish: Effect.Effect<void> = publishing
    .withPermits(1)(
      Effect.gen(function* () {
        const all = yield* asks.list({ settled: true });
        const rows = yield* Effect.forEach(
          all,
          (ask) => Effect.map(targetOf(ask), (target) => rowOf(ask, target)),
          { concurrency: 4 },
        );
        posterThreads = new Set(
          all.flatMap((ask) => ("thread" in ask.poster ? [ask.poster.thread] : [])),
        );
        yield* host.ui.publish("shelf-row", rows);
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
              Effect.sleep(Math.max(0, next - now) + 1000).pipe(Effect.andThen(publishLater)),
            )
          : undefined;
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Pult could not publish the asks' rows.", { cause }),
      ),
    );
  const publishLater = Effect.suspend(() => publish);

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
      yield* publish;
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
      yield* publish;
      return sent;
    }),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(host.threadEvents, (event) =>
      posterThreads.has(event.threadId) ? publish : Effect.void,
    ),
  );
  yield* Effect.forkScoped(publish);
  return { publish } satisfies AskRows;
});
