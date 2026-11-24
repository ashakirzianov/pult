// The Stars' schedules (xaxis `pult/tasks/star-schedules.task`), kept in memory with the next due
// time and read again when the watch names one, a run comes due, or ten minutes passed. Each due
// run is one delivery as the plugin, then its record in `.pult/runs/`; a watcher's (`run:`) runs
// its command first, and a silent command leaves no record, only memory.
import {
  Cause,
  DateTime,
  Digest,
  Effect,
  FileSystem,
  Option,
  Path,
  Scheduler,
  ServerConfig,
  ServerEnvironment,
  Stream,
  WorkspaceEntries,
} from "../host.ts";
import type { Deliver } from "../stars/deliver.ts";
import type { CommandOutcome, RunCommand } from "./command.ts";
import type { Star, Stars, StarsView } from "../stars/stars.ts";
import {
  isRunFileName,
  type LastRun,
  parseLastRun,
  type RunRecord,
  RUNS_DIRECTORY,
  runFileName,
  runRecordText,
} from "./run.ts";
import {
  latestDue,
  minuteOf,
  nextDue,
  type Parsed,
  parseSchedule,
  type Rule,
  ruleInWords,
  type Schedule,
  SCHEDULES_DIRECTORY,
  scheduleName,
  wallClock,
} from "./schedule.ts";

/** The watch's backstop: a schedule it never told of is read this long after the last read at most. */
const BACKSTOP_MS = 10 * 60_000;
/** A run delivered later than this says how late. */
const LATE_MS = 5 * 60_000;

/** A schedule as `GET /stars` serves it, by name; `rule` and `timezone` null for a file that is no schedule. */
export interface ScheduleView {
  readonly name: string;
  /** The file's `title`, shown in place of the name; null where it has none or is no schedule. */
  readonly title: string | null;
  readonly path: string;
  readonly rule: string | null;
  /** The rule's kind, which the page draws its icon by; null for a file that is no schedule. */
  readonly kind: Rule["kind"] | null;
  readonly timezone: string | null;
  /** The next due instant, ISO; null where none is. */
  readonly next: string | null;
  /** A one-off whose run has a record. */
  readonly spent: boolean;
  /** Why the file will not run, else null. */
  readonly problem: string | null;
  readonly last: LastRun | null;
}

export type StarsViewWithSchedules = Omit<StarsView, "stars"> & {
  readonly stars: ReadonlyArray<
    StarsView["stars"][number] & { readonly schedules: ReadonlyArray<ScheduleView> }
  >;
};

export interface Schedules {
  /** Whether this server fires schedules: no `schedules-off` in its state. */
  readonly firing: Effect.Effect<boolean>;
  /** The view with each Star's schedules, read again first where the watch said they changed. */
  readonly withSchedules: (view: StarsView) => Effect.Effect<StarsViewWithSchedules>;
}

/** One file of a Star's schedules, as last read. */
interface ScheduleFile {
  readonly name: string;
  readonly path: string;
  readonly text: string;
  /** No run due before this fires: the minute the file last changed. */
  readonly floor: number;
  readonly parsed: Parsed;
  readonly problem: string | null;
  /** The run records' files of the schedule, by name. */
  readonly runs: ReadonlySet<string>;
  readonly last: LastRun | null;
}

interface StarSchedules {
  readonly star: Star;
  readonly files: ReadonlyArray<ScheduleFile>;
}

/** Whether a changed path, relative to the Stars directory, may change what a Star's schedules are. */
export function namesSchedules(changed: string): boolean {
  const [folder, system, inside, ...rest] = changed.split("/");
  if (folder === undefined || folder === "") return false;
  if (system === undefined) return true;
  if (system !== ".pult") return false;
  return (
    inside === undefined || inside === "schedules" || (inside === "star.yaml" && rest.length === 0)
  );
}

const lateness = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
};

const notInterrupted = <E>(cause: Cause.Cause<E>) => !Cause.hasInterruptsOnly(cause);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

/** Why a one-off with no record will never run: its time had passed when the file was written. */
const passedProblem = (file: ScheduleFile): string | undefined => {
  if (!file.parsed.ok || file.parsed.schedule.rule.kind !== "once") return undefined;
  const due = latestDue(file.parsed.schedule, Number.POSITIVE_INFINITY);
  if (due === undefined || due >= file.floor || file.runs.has(runFileName(due))) return undefined;
  return `it is a one-off for ${wallClock(file.parsed.schedule.zone, due)} ${file.parsed.schedule.timezone}, which had passed when the file was written`;
};

export const make = Effect.fn("Schedules.make")(function* (
  stars: Pick<Stars, "directory" | "list">,
  deliver: Deliver,
  runCommand: RunCommand,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const scheduler = yield* Scheduler.Scheduler;
  const entries = yield* WorkspaceEntries.WorkspaceEntries;
  const digest = yield* Digest.Digest;
  const scope = yield* Effect.scope;

  const environmentId = yield* environment.getEnvironmentId;
  const offFile = path.join(config.stateDir, "plugins", "pult", "schedules-off");

  let known: ReadonlyArray<StarSchedules> = [];
  /** Set at start, by the watch, and after a run fired; cleared as a pass begins to read. */
  let stale = true;
  let readAt: number | undefined;
  let earliestDue: number | undefined;
  let watching = false;
  /** The keys of the problems told this run of the server; the delivery's key holds across restarts. */
  const told = new Set<string>();
  /** The runs fired this run of the server whose record failed to write: not fired again until a restart. */
  const unrecorded = new Set<string>();
  const runKey = (star: Star, name: string, due: number) => `${star.id}:${name}:${iso(due)}`;
  /** A watcher's last due run this run of the server, by `<star>:<name>`: a silent run leaves no record. */
  const ran = new Map<string, number>();
  /** The watchers whose last run failed, by `<star>:<name>`: told once per streak. */
  const failing = new Set<string>();

  const firing = Effect.map(fs.exists(offFile), (off) => !off).pipe(
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("Could not look for schedules-off.", { offFile, cause }), false),
    ),
  );

  const subscribe = Effect.gen(function* () {
    watching = true;
    yield* entries.watch({ cwd: stars.directory }).pipe(
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          if (batch.truncated || batch.changes.some((change) => namesSchedules(change.path)))
            stale = true;
        }),
      ),
      Effect.catchCauseIf(notInterrupted, (cause) =>
        Effect.logWarning("The watch of the Stars directory failed.", { cause }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          watching = false;
          stale = true;
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  /** A file of a Star's schedules; one that fails to read, or whose runs fail to, is a problem of its own. */
  const readOne = Effect.fn("Schedules.readOne")(function* (
    folder: string,
    runs: string,
    file: string,
  ) {
    const name = scheduleName(file);
    if (name === undefined) return [];
    const filePath = path.join(folder, file);
    const runsFolder = path.join(runs, name);
    /** A file that will not run: no run is due, and `problem` says why. */
    const problem = (
      text: string,
      why: string,
      parsed: Parsed = { ok: false, problem: why },
    ): ReadonlyArray<ScheduleFile> => [
      {
        name,
        path: filePath,
        text,
        floor: Number.POSITIVE_INFINITY,
        parsed,
        problem: why,
        runs: new Set(),
        last: null,
      },
    ];
    const failed =
      (text: string, why: string) =>
      <E>(cause: Cause.Cause<E>) =>
        Effect.succeed(problem(text, `${why}: ${messageOf(Cause.squash(cause))}`));
    return yield* Effect.gen(function* () {
      const info = yield* fs.stat(filePath);
      if (info.type !== "File") return [];
      const text = yield* fs.readFileString(filePath);
      if (Option.isNone(info.mtime))
        return problem(
          text,
          "the file system gives it no modification time, which its first run is counted from",
        );
      const floor = minuteOf(info.mtime.value.getTime());
      const parsed = parseSchedule(name, text);
      return yield* Effect.gen(function* () {
        const runFiles = (yield* fs.exists(runsFolder))
          ? (yield* fs.readDirectory(runsFolder)).filter(isRunFileName).toSorted()
          : [];
        const newest = runFiles.at(-1);
        const last =
          newest === undefined
            ? null
            : (parseLastRun(yield* fs.readFileString(path.join(runsFolder, newest))) ?? null);
        return [
          {
            name,
            path: filePath,
            text,
            floor,
            parsed,
            problem: null,
            runs: new Set(runFiles),
            last,
          } satisfies ScheduleFile,
        ];
      }).pipe(
        Effect.catchCauseIf(notInterrupted, (cause) =>
          Effect.succeed(
            problem(
              text,
              `its runs, \`${RUNS_DIRECTORY}/${name}\`, could not be read: ${messageOf(Cause.squash(cause))}`,
              parsed,
            ),
          ),
        ),
      );
    }).pipe(Effect.catchCauseIf(notInterrupted, failed("", "it could not be read")));
  });

  /** Every Star's schedule files; a Star whose folder fails to list has none, logged. */
  const read = Effect.gen(function* () {
    const found = yield* stars.list;
    known = yield* Effect.forEach(found, (star) =>
      Effect.gen(function* () {
        const folder = path.join(star.root, SCHEDULES_DIRECTORY);
        if (!(yield* fs.exists(folder))) return { star, files: [] };
        const runs = path.join(star.root, RUNS_DIRECTORY);
        const names = (yield* fs.readDirectory(folder)).toSorted();
        const files = yield* Effect.forEach(names, (file) => readOne(folder, runs, file));
        return { star, files: files.flat() };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("Could not read a Star's schedules.", { starId: star.id, cause }),
            { star, files: [] },
          ),
        ),
      ),
    );
  }).pipe(Effect.withSpan("Schedules.read"));

  /**
   * One delivery of the run due at `due`, or its failure before any, then its record; a failed
   * delivery is recorded and not retried, and a record that fails to write keeps the run from
   * firing again until a restart.
   */
  const fire = Effect.fn("Schedules.fire")(function* (
    star: Star,
    schedule: Schedule,
    due: number,
    /** The message and its sender's line, or why the run failed before it had one. */
    message: { readonly text: string; readonly from: string } | { readonly failed: string },
  ) {
    const outcome =
      "failed" in message
        ? { result: "failed" as const, error: message.failed, thread: null }
        : yield* deliver({
            star,
            text: message.text,
            from: message.from,
            key: `schedule:${schedule.name}:${iso(due)}`,
            to: schedule.to,
            sender: "plugin",
          }).pipe(
            Effect.map((delivered) => ({
              result: delivered.outcome,
              error: null,
              thread: delivered.threadId,
            })),
            Effect.catchCauseIf(notInterrupted, (cause) =>
              Effect.succeed({
                result: "failed" as const,
                error: messageOf(Cause.squash(cause)),
                thread: null,
              }),
            ),
          );
    const record: RunRecord = {
      schedule: schedule.name,
      due: iso(due),
      environment: environmentId,
      fired: iso(DateTime.toEpochMillis(yield* DateTime.now)),
      ...outcome,
    };
    const folder = path.join(star.root, RUNS_DIRECTORY, schedule.name);
    yield* Effect.flatMap(fs.makeDirectory(folder, { recursive: true }), () =>
      fs.writeFileString(path.join(folder, runFileName(due)), runRecordText(record)),
    ).pipe(
      Effect.catchCauseIf(notInterrupted, (cause) => {
        unrecorded.add(runKey(star, schedule.name, due));
        return Effect.logError(
          "Could not record a Star's scheduled run; it does not fire again until the server restarts.",
          {
            starId: star.id,
            schedule: schedule.name,
            due: record.due,
            result: record.result,
            cause,
          },
        );
      }),
    );
    if (record.result === "failed")
      yield* Effect.logWarning("A Star's scheduled run failed.", {
        starId: star.id,
        schedule: schedule.name,
        error: record.error,
      });
  });

  /** A plain schedule's due run: its message, saying how late where it is. */
  const fireMessage = Effect.fn("Schedules.fireMessage")(function* (
    star: Star,
    schedule: Schedule,
    due: number,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const late = now - due > LATE_MS ? `, delivered ${lateness(now - due)} late` : "";
    yield* fire(star, schedule, due, {
      text: schedule.text,
      from: `schedule ${schedule.name}, due ${wallClock(schedule.zone, due)} ${schedule.timezone}${late}`,
    });
  });

  /**
   * A watcher's due run: its command, then its message followed by what the command printed, or
   * its failure, told to the Star once per streak of failures. A silent run is remembered alone.
   */
  const watch = Effect.fn("Schedules.watch")(function* (
    star: Star,
    schedule: Schedule,
    command: string,
    due: number,
  ) {
    const key = `${star.id}:${schedule.name}`;
    ran.set(key, due);
    const started = DateTime.toEpochMillis(yield* DateTime.now);
    const outcome: CommandOutcome = yield* runCommand(star.root, command);
    if (outcome.kind !== "failed") failing.delete(key);
    switch (outcome.kind) {
      case "silent":
        return false;
      case "printed":
        yield* fire(star, schedule, due, {
          text: `${schedule.text}\n\n${outcome.output}`,
          from: `schedule ${schedule.name}'s command, ran ${wallClock(schedule.zone, started)} ${schedule.timezone}`,
        });
        return true;
      case "failed":
        yield* fire(star, schedule, due, { failed: outcome.error });
        if (!failing.has(key)) {
          failing.add(key);
          yield* deliver({
            star,
            text: `\`${SCHEDULES_DIRECTORY}/${schedule.name}.md\`'s command failed: ${outcome.error}. Pult tells you again only after it has run cleanly.`,
            from: `Pult, about schedule ${schedule.name}`,
            key: `schedule-command-failed:${schedule.name}:${iso(due)}`,
            to: schedule.to,
            sender: "plugin",
          }).pipe(
            Effect.catchCauseIf(notInterrupted, (cause) =>
              Effect.logWarning("Could not tell a Star its schedule's command failed.", {
                starId: star.id,
                schedule: schedule.name,
                cause,
              }),
            ),
          );
        }
        return true;
    }
  });

  /** Tells the Star once per content why a file of its schedules will not run. */
  const tell = Effect.fn("Schedules.tell")(function* (star: Star, file: ScheduleFile, why: string) {
    const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(file.text));
    const key = `schedule-problem:${file.name}:${hash.slice(0, 16)}`;
    if (told.has(`${star.id}:${key}`)) return;
    told.add(`${star.id}:${key}`);
    yield* deliver({
      star,
      text: `\`${SCHEDULES_DIRECTORY}/${file.name}.md\` will not run: ${why}. Fix the file or delete it; Pult tells you once per content.`,
      from: `Pult, about schedule ${file.name}`,
      key,
      // A file that is no schedule names no channel: the default channel's.
      sender: "plugin",
    }).pipe(
      Effect.catchCauseIf(notInterrupted, (cause) =>
        Effect.logWarning("Could not tell a Star its schedule is none.", {
          starId: star.id,
          schedule: file.name,
          cause,
        }),
      ),
    );
  });

  /**
   * Fires each latest due run with no record that came due since its file changed, and tells each
   * problem; then runs the due watchers' commands at once, the pass waiting for them.
   */
  const fireDue = Effect.fn("Schedules.fireDue")(function* (now: number) {
    let fired = false;
    const watchers: Array<{ star: Star; schedule: Schedule; command: string; due: number }> = [];
    for (const { star, files } of known)
      for (const file of files)
        yield* Effect.gen(function* () {
          if (!file.parsed.ok) return yield* tell(star, file, file.parsed.problem);
          if (file.problem !== null) return yield* tell(star, file, file.problem);
          const passed = passedProblem(file);
          if (passed !== undefined) return yield* tell(star, file, passed);
          const due = latestDue(file.parsed.schedule, now);
          if (due === undefined || due < file.floor || file.runs.has(runFileName(due))) return;
          if (unrecorded.has(runKey(star, file.name, due))) return;
          const schedule = file.parsed.schedule;
          if (schedule.command !== undefined) {
            if (ran.get(`${star.id}:${file.name}`) !== due)
              watchers.push({ star, schedule, command: schedule.command, due });
            return;
          }
          fired = true;
          yield* fireMessage(star, schedule, due);
        }).pipe(
          Effect.catchCauseIf(notInterrupted, (cause) =>
            Effect.logWarning("Could not run a Star's schedule.", {
              starId: star.id,
              schedule: file.name,
              cause,
            }),
          ),
        );
    const watched = yield* Effect.forEach(
      watchers,
      ({ star, schedule, command, due }) =>
        watch(star, schedule, command, due).pipe(
          Effect.catchCauseIf(notInterrupted, (cause) =>
            Effect.as(
              Effect.logWarning("Could not run a Star's schedule.", {
                starId: star.id,
                schedule: schedule.name,
                cause,
              }),
              false,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return fired || watched.includes(true);
  });

  const earliestAfter = (now: number) => {
    const dues = known.flatMap(({ files }) =>
      files.flatMap((file) => {
        const due =
          file.problem === null && file.parsed.ok ? nextDue(file.parsed.schedule, now) : undefined;
        return due === undefined ? [] : [due];
      }),
    );
    return dues.length === 0 ? undefined : Math.min(...dues);
  };

  const pass = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const due = earliestDue !== undefined && now >= earliestDue;
    const backstop = readAt === undefined || now - readAt >= BACKSTOP_MS;
    // The directory is missing until a first Star is made: until a watch runs, each tick looks for it.
    const unwatched = !watching && (yield* fs.exists(stars.directory));
    if (!stale && !due && !backstop && !unwatched) return;
    // Cleared before the read, so a change the watch tells of meanwhile reads again.
    stale = false;
    readAt = now;
    if (unwatched) yield* subscribe;
    yield* read;
    // A run fired: its record is read back on the next tick.
    if ((yield* firing) && (yield* fireDue(now))) stale = true;
    earliestDue = earliestAfter(now);
  }).pipe(
    Effect.catchCauseIf(notInterrupted, (cause) =>
      Effect.logWarning("Could not look at the Stars' schedules.", { cause }),
    ),
    Effect.withSpan("Schedules.pass"),
  );
  yield* scheduler.register("pult-schedules", pass);

  const viewOf = (star: Star, now: number): ReadonlyArray<ScheduleView> =>
    (known.find((each) => each.star.id === star.id)?.files ?? []).map((file) => {
      const last = file.last;
      if (!file.parsed.ok)
        return {
          name: file.name,
          title: null,
          path: file.path,
          rule: null,
          kind: null,
          timezone: null,
          next: null,
          spent: false,
          problem: file.parsed.problem,
          last,
        };
      const schedule = file.parsed.schedule;
      const passed = file.problem ?? passedProblem(file);
      const latest = latestDue(schedule, now);
      const next = nextDue(schedule, now);
      return {
        name: file.name,
        title: schedule.title ?? null,
        path: file.path,
        rule:
          schedule.command === undefined
            ? ruleInWords(schedule.rule)
            : `${ruleInWords(schedule.rule)}, runs ${schedule.command}`,
        kind: schedule.rule.kind,
        timezone: schedule.timezone,
        next: passed !== undefined || next === undefined ? null : iso(next),
        spent:
          schedule.rule.kind === "once" &&
          latest !== undefined &&
          file.runs.has(runFileName(latest)),
        problem: passed ?? null,
        last,
      };
    });

  const withSchedules: Schedules["withSchedules"] = Effect.fn("Schedules.withSchedules")(
    function* (view) {
      if (stale)
        yield* read.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read the Stars' schedules.", { cause }),
          ),
        );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return {
        ...view,
        stars: view.stars.map((star) => ({ ...star, schedules: viewOf(star, now) })),
      };
    },
  );

  return { firing, withSchedules } satisfies Schedules;
});
