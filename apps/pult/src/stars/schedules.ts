// A Star's schedules as its card lists them (xaxis `pult/issues/star-schedules.md`), apart from
// the workbench so `node --test src/stars/schedules.test.ts` can run it. The page parses no
// schedule file and does no rule math: the rule in words, the next due instant and the last run
// are the plugin's, from the `stars` route; the page formats the instants in its own zone and
// adds the schedule's city where its zone is another.
import type { RouteSchedule } from "./plugin.ts";

/** A schedule's row on the card. */
export interface ScheduleRow {
  readonly name: string;
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
      path: schedule.path,
      next: schedule.next === null ? undefined : instantText(schedule.next, now, pageZone),
      rule,
      spent: schedule.spent,
    };
    if (schedule.problem !== null) {
      const last = `${schedule.rule === null ? "not a schedule" : "will not run"}: ${schedule.problem}`;
      return { ...base, last, detail: last, warning: true };
    }
    if (schedule.last === null)
      return { ...base, last: "not run yet", detail: undefined, warning: false };
    const due = instantText(schedule.last.due, now, pageZone);
    return schedule.last.result === "failed"
      ? { ...base, last: `failed ${due}`, detail: schedule.last.error ?? undefined, warning: true }
      : { ...base, last: `ran ${due}`, detail: undefined, warning: false };
  });
}
