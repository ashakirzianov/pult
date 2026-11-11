// A Star's schedule (xaxis `pult/issues/star-schedules.md`): `.pult/schedules/<name>.md`, a front
// matter with a required IANA `timezone` and one rule over the message as its body. Read
// strictly: a file that is anything else is no schedule, and says why. Every due time is a
// function of the file alone, so it is the same on every environment.
import { DateTime, Option } from "../host.ts";
import { entry, frontMatter, SYSTEM_DIRECTORY } from "../stars/record.ts";

export const SCHEDULES_DIRECTORY = `${SYSTEM_DIRECTORY}/schedules`;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Minutes, by how `every` writes them. */
const INTERVALS: ReadonlyMap<string, number> = new Map([
  ["15m", 15],
  ["30m", 30],
  ["1h", 60],
  ["2h", 120],
  ["3h", 180],
  ["4h", 240],
  ["6h", 360],
  ["8h", 480],
  ["12h", 720],
]);

const KEYS: ReadonlySet<string> = new Set(["timezone", "time", "days", "date", "every"]);

interface ClockTime {
  readonly hour: number;
  readonly minute: number;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type Rule =
  /** Every day, or on `days` alone. */
  | {
      readonly kind: "daily";
      readonly time: ClockTime;
      readonly days: ReadonlyArray<Weekday> | undefined;
    }
  | { readonly kind: "once"; readonly time: ClockTime; readonly date: CalendarDate }
  /** Every `minutes`, counted from midnight in the zone. */
  | { readonly kind: "every"; readonly minutes: number };

export interface Schedule {
  readonly name: string;
  readonly timezone: string;
  readonly zone: DateTime.TimeZone;
  readonly rule: Rule;
  /** The message, the body with its surrounding blank lines dropped. */
  readonly text: string;
}

export type Parsed =
  | { readonly ok: true; readonly schedule: Schedule }
  | { readonly ok: false; readonly problem: string };

/** The schedule a file of the folder is, by its name without `.md`; undefined for a file that is none of the folder's. */
export const scheduleName = (file: string): string | undefined =>
  file.endsWith(".md") && file.length > ".md".length ? file.slice(0, -".md".length) : undefined;

const problem = (text: string): Parsed => ({ ok: false, problem: text });

const parseTime = (value: string): ClockTime | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
};

const utcDate = (date: CalendarDate) =>
  DateTime.makeUnsafe({ ...date, hour: 0, minute: 0, second: 0, millisecond: 0 });

const parseDate = (value: string): CalendarDate | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return undefined;
  // A day past its month's end rolls into the next month.
  const parts = DateTime.toPartsUtc(utcDate(date));
  return parts.month === date.month && parts.day === date.day ? date : undefined;
};

const unquoteItem = (item: string) => (/^"[^"]*"$|^'[^']*'$/.test(item) ? item.slice(1, -1) : item);

/** A flow list of weekdays, `[mon, wed]`, each once. */
const parseDays = (value: string): ReadonlyArray<Weekday> | undefined => {
  const match = /^\[(.*)\]$/.exec(value);
  if (match === null) return undefined;
  const items = (match[1] ?? "").split(",").map((item) => unquoteItem(item.trim()));
  const days = items.filter((item): item is Weekday =>
    (WEEKDAYS as ReadonlyArray<string>).includes(item),
  );
  return days.length === items.length && days.length > 0 && new Set(days).size === days.length
    ? days
    : undefined;
};

/** The file `<name>.md` read as a schedule, or why it is none. */
export function parseSchedule(name: string, text: string): Parsed {
  if (!/^[a-z0-9-]+$/.test(name))
    return problem(`its name, "${name}", is not lowercase letters, digits and hyphens`);
  const matter = frontMatter(text);
  if (matter === undefined)
    return problem("it does not open with a front matter between two `---` lines");
  const fields = new Map<string, string>();
  for (const line of matter.lines) {
    if (line.trim() === "") continue;
    const parsed = entry(line);
    if (parsed === undefined)
      return problem(`its front matter's line "${line}" is not \`key: value\``);
    if (!KEYS.has(parsed.key))
      return problem(
        `\`${parsed.key}\` is no key of a schedule's; they are timezone, time, days, date and every`,
      );
    if (fields.has(parsed.key)) return problem(`\`${parsed.key}\` is given twice`);
    fields.set(parsed.key, parsed.value);
  }
  const timezone = fields.get("timezone");
  if (timezone === undefined) return problem("it has no `timezone`, an IANA name");
  const zone = DateTime.zoneMakeNamed(timezone);
  if (Option.isNone(zone)) return problem(`\`timezone\` "${timezone}" is no IANA time zone`);
  const message = text.slice(matter.bodyStart).trim();
  if (message === "") return problem("its message, the text after the front matter, is empty");

  const time = fields.get("time");
  const days = fields.get("days");
  const date = fields.get("date");
  const every = fields.get("every");
  const schedule = (rule: Rule): Parsed => ({
    ok: true,
    schedule: { name, timezone, zone: zone.value, rule, text: message },
  });
  if (time !== undefined && every !== undefined)
    return problem("it has both `time` and `every`; a schedule has one of them");
  if (every !== undefined) {
    if (days !== undefined || date !== undefined)
      return problem("`days` and `date` go with `time`, not with `every`");
    const minutes = INTERVALS.get(every);
    if (minutes === undefined)
      return problem(`\`every\` "${every}" is not one of 15m, 30m, 1h, 2h, 3h, 4h, 6h, 8h or 12h`);
    return schedule({ kind: "every", minutes });
  }
  if (time === undefined) return problem("it has neither `time` nor `every`");
  const clock = parseTime(time);
  if (clock === undefined) return problem(`\`time\` "${time}" is not HH:MM`);
  if (days !== undefined && date !== undefined)
    return problem("it has both `days` and `date`; a schedule has one of them at most");
  if (date !== undefined) {
    const calendar = parseDate(date);
    if (calendar === undefined) return problem(`\`date\` "${date}" is not a date, YYYY-MM-DD`);
    return schedule({ kind: "once", time: clock, date: calendar });
  }
  if (days !== undefined) {
    const weekdays = parseDays(days);
    if (weekdays === undefined)
      return problem(`\`days\` "${days}" is not a list of mon to sun, each once, as [mon, wed]`);
    return schedule({ kind: "daily", time: clock, days: weekdays });
  }
  return schedule({ kind: "daily", time: clock, days: undefined });
}

const MINUTE_MS = 60_000;

const addDays = (date: CalendarDate, days: number): CalendarDate => {
  const parts = DateTime.toPartsUtc(DateTime.add(utcDate(date), { days }));
  return { year: parts.year, month: parts.month, day: parts.day };
};

// `weekDay` is 0 for Sunday to 6 for Saturday, as WEEKDAYS is ordered.
const weekdayOf = (date: CalendarDate) =>
  WEEKDAYS[DateTime.toPartsUtc(utcDate(date)).weekDay] as Weekday;

/** The wall-clock time in the zone: a time in a gap is the instant after it, a repeated one the earlier. */
const instantOf = (zone: DateTime.TimeZone, date: CalendarDate, time: ClockTime) =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      { ...date, hour: time.hour, minute: time.minute, second: 0, millisecond: 0 },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  );

/** The instants the rule names on one date of its zone. */
function dueOn(schedule: Schedule, date: CalendarDate): ReadonlyArray<number> {
  const { rule, zone } = schedule;
  switch (rule.kind) {
    case "daily":
      return rule.days === undefined || rule.days.includes(weekdayOf(date))
        ? [instantOf(zone, date, rule.time)]
        : [];
    case "once":
      return [];
    case "every": {
      const instants: number[] = [];
      for (let minutes = 0; minutes < 24 * 60; minutes += rule.minutes)
        instants.push(
          instantOf(zone, date, { hour: Math.floor(minutes / 60), minute: minutes % 60 }),
        );
      return instants;
    }
  }
}

const dateIn = (zone: DateTime.TimeZone, at: number): CalendarDate => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: zone }));
  return { year: parts.year, month: parts.month, day: parts.day };
};

/** The instants of the dates from `from` to `to` days around `at`'s date in the zone. */
const dueAround = (schedule: Schedule, at: number, from: number, to: number) => {
  const today = dateIn(schedule.zone, at);
  const instants: number[] = [];
  for (let offset = from; offset <= to; offset += 1)
    instants.push(...dueOn(schedule, addDays(today, offset)));
  return instants;
};

/** The latest due time at or before `at`, in epoch milliseconds; undefined where none is. */
export function latestDue(schedule: Schedule, at: number): number | undefined {
  const { rule } = schedule;
  if (rule.kind === "once") {
    const instant = instantOf(schedule.zone, rule.date, rule.time);
    return instant <= at ? instant : undefined;
  }
  // A week back finds any weekday; a day ahead covers a time pushed past midnight by a gap.
  const past = dueAround(schedule, at, -8, 1).filter((instant) => instant <= at);
  return past.length === 0 ? undefined : Math.max(...past);
}

/** The first due time after `at`, in epoch milliseconds; undefined where none is. */
export function nextDue(schedule: Schedule, at: number): number | undefined {
  const { rule } = schedule;
  if (rule.kind === "once") {
    const instant = instantOf(schedule.zone, rule.date, rule.time);
    return instant > at ? instant : undefined;
  }
  const coming = dueAround(schedule, at, -1, 8).filter((instant) => instant > at);
  return coming.length === 0 ? undefined : Math.min(...coming);
}

/** The start of the minute `at` is in: no run due before it fires for a file changed at `at`. */
export const minuteOf = (at: number) => Math.floor(at / MINUTE_MS) * MINUTE_MS;

const pad = (value: number) => String(value).padStart(2, "0");

const clockText = (time: ClockTime) => `${pad(time.hour)}:${pad(time.minute)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEK_ORDER: ReadonlyArray<Weekday> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The rule in words, as the card shows it: `weekdays 09:00`, `every 2h`, `once, 12 Nov 10:00`. */
export function ruleInWords(rule: Rule): string {
  switch (rule.kind) {
    case "every":
      return rule.minutes < 60 ? `every ${rule.minutes}m` : `every ${rule.minutes / 60}h`;
    case "once":
      return `once, ${rule.date.day} ${MONTHS[rule.date.month - 1]} ${clockText(rule.time)}`;
    case "daily": {
      const days = WEEK_ORDER.filter((day) => rule.days?.includes(day) ?? true);
      const words =
        days.length === 7
          ? "every day"
          : days.join() === "mon,tue,wed,thu,fri"
            ? "weekdays"
            : days.join() === "sat,sun"
              ? "weekends"
              : days.join(", ");
      return `${words} ${clockText(rule.time)}`;
    }
  }
}

/** An instant as the zone's wall clock, `2026-11-10 09:00`. */
export function wallClock(zone: DateTime.TimeZone, at: number): string {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: zone }));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}
