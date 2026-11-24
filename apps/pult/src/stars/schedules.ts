// A Star's schedules as its details list them (xaxis `pult/tasks/star-schedules.task`), apart from
// the workbench so `node --test src/stars/schedules.test.ts` can run it. The page parses no
// schedule file and does no rule math: the rule in words, the next due instant and the last run
// are the plugin's, from the `stars` route; the page formats the instants in its own zone and
// adds the schedule's city where its zone is another.
import type { RouteSchedule, ScheduleKind } from "./plugin.ts";

/** A schedule's row on the card. */
export interface ScheduleRow {
  readonly name: string;
  /** What the row shows for it: the file's title, else its name. */
  readonly label: string;
  /** Its hover: a titled row's file, which names it, then any detail; an untitled row's detail, else its file. */
  readonly hover: string;
  /** The rule's kind, which picks the row's icon; undefined for a file that is no schedule. */
  readonly kind: ScheduleKind | undefined;
  readonly path: string;
  /** The next run, in the page's zone, `tomorrow 09:00`; undefined where none is. */
  readonly next: string | undefined;
  /** The rule in words, with the schedule's city where its zone is not the page's; undefined for a file that is no schedule. */
  readonly rule: string | undefined;
  /** The last run, or why the file will not run: `ran today 09:00`, `failed today 09:00`, `not a schedule: …`. */
  readonly last: string;
  /** What the last run's text leaves out: a failure's error, a problem in full. */
  readonly detail: string | undefined;
  /** A failed last run, or a file that will not run. */
  readonly warning: boolean;
  /** A one-off that has run, dimmed. */
  readonly spent: boolean;
}

/** The zone's canonical name as the page's `Intl` reads it, undefined for one it does not know. */
function canonicalZone(zone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** A zone's city, its last segment in words: `America/Argentina/Buenos_Aires` is Buenos Aires, `UTC` itself. */
export function cityOf(zone: string): string {
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

const dayKey = (at: Date, zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** Whole days from `now`'s day to `at`'s, in the zone. */
function daysBetween(now: Date, at: Date, zone: string): number {
  return Math.round((Date.parse(dayKey(at, zone)) - Date.parse(dayKey(now, zone))) / 86_400_000);
}

/** An instant in the zone as the card says it: `today 09:00`, `tomorrow 09:00`, `yesterday 09:00`, `12 Nov 09:00`, a year added outside `now`'s. */
export function instantText(iso: string, now: number, zone: string): string {
  const at = new Date(iso);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const days = daysBetween(new Date(now), at, zone);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  const sameYear = dayKey(at, zone).slice(0, 4) === dayKey(new Date(now), zone).slice(0, 4);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
  return `${date} ${clock}`;
}

/** A row's last run, or why its file will not run. */
function statusOf(
  schedule: RouteSchedule,
  now: number,
  pageZone: string,
): Pick<ScheduleRow, "last" | "detail" | "warning"> {
  if (schedule.problem !== null) {
    const last = `${schedule.rule === null ? "not a schedule" : "will not run"}: ${schedule.problem}`;
    return { last, detail: last, warning: true };
  }
  if (schedule.last === null) return { last: "not run yet", detail: undefined, warning: false };
  const due = instantText(schedule.last.due, now, pageZone);
  return schedule.last.result === "failed"
    ? { last: `failed ${due}`, detail: schedule.last.error ?? undefined, warning: true }
    : { last: `ran ${due}`, detail: undefined, warning: false };
}

/**
 * The card's rows of a home's schedules, in the plugin's order: a file
 * that is no schedule says so; a schedule that will not run says why; else
 * the last run, by its due time, and the next one.
 */
export function scheduleRows(
  schedules: ReadonlyArray<RouteSchedule>,
  now: number,
  pageZone: string,
): ReadonlyArray<ScheduleRow> {
  const page = canonicalZone(pageZone) ?? pageZone;
  return schedules.map((schedule) => {
    const rule =
      schedule.rule === null
        ? undefined
        : schedule.timezone === null ||
            (canonicalZone(schedule.timezone) ?? schedule.timezone) === page
          ? schedule.rule
          : `${schedule.rule} (${cityOf(schedule.timezone)})`;
    const base = {
      name: schedule.name,
      label: schedule.title ?? schedule.name,
      kind: schedule.kind ?? undefined,
      path: schedule.path,
      // A next run already past is due, firing on the home's next tick, or not at all where schedules are off.
      next:
        schedule.next === null
          ? undefined
          : Date.parse(schedule.next) <= now
            ? "due"
            : instantText(schedule.next, now, pageZone),
      rule,
      spent: schedule.spent,
    };
    const status = statusOf(schedule, now, pageZone);
    const hover =
      schedule.title === null
        ? (status.detail ?? schedule.path)
        : [schedule.path, status.detail].filter((line) => line !== undefined).join("\n");
    return { ...base, ...status, hover };
  });
}
