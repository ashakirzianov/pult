import { assert, describe, it } from "@effect/vitest";

import { DateTime } from "../host.ts";
import {
  latestDue,
  minuteOf,
  nextDue,
  parseSchedule,
  ruleInWords,
  type Schedule,
  scheduleName,
  wallClock,
} from "./schedule.ts";

const file = (matter: string, body = "Morning pass.") => `---\n${matter}\n---\n${body}\n`;

describe("parseSchedule", () => {
  const valid: ReadonlyArray<readonly [matter: string, words: string]> = [
    ['timezone: America/New_York\ntime: "09:00"', "every day 09:00"],
    ["timezone: America/New_York\ntime: 09:00", "every day 09:00"],
    ["timezone: UTC\ntime: '23:59'\ndays: [mon, tue, wed, thu, fri]", "weekdays 23:59"],
    ["timezone: UTC\ntime: 07:30\ndays: [sun, sat]", "weekends 07:30"],
    ['timezone: UTC\ntime: 07:30\ndays: ["fri", mon]', "mon, fri 07:30"],
    ["timezone: UTC\ntime: 00:00\ndays: [mon, tue, wed, thu, fri, sat, sun]", "every day 00:00"],
    ["timezone: Europe/Berlin\ntime: 10:00\ndate: 2026-11-12", "once, 12 Nov 10:00"],
    ["timezone: UTC\nevery: 15m", "every 15m"],
    ["\ntimezone: UTC\n\nevery: 12h\n", "every 12h"],
  ];
  it.each(valid)("reads %j as %j", (matter, words) => {
    const parsed = parseSchedule("standup", file(matter));
    assert.isTrue(parsed.ok);
    if (parsed.ok) assert.strictEqual(ruleInWords(parsed.schedule.rule), words);
  });

  it("keeps the body, trimmed, as the message, and the timezone as written", () => {
    const parsed = parseSchedule(
      "standup",
      "---\r\ntimezone: Asia/Tokyo\r\ntime: 09:00\r\n---\r\n\r\nTriage.\r\nThen brief me.\r\n\r\n",
    );
    assert.deepInclude(parsed.ok ? parsed.schedule : {}, {
      name: "standup",
      timezone: "Asia/Tokyo",
      text: "Triage.\r\nThen brief me.",
    });
  });

  it("reads `to` as the conversation a run lands in, the one with the user where absent", () => {
    const to = (matter: string) => {
      const parsed = parseSchedule("standup", file(matter));
      return parsed.ok ? parsed.schedule.to : parsed.problem;
    };
    assert.strictEqual(to("timezone: UTC\ntime: 09:00"), "user");
    assert.strictEqual(to("timezone: UTC\ntime: 09:00\nto: user"), "user");
    assert.strictEqual(to("timezone: UTC\nevery: 1h\nto: work"), "work");
    assert.strictEqual(to('timezone: UTC\ntime: 09:00\nto: "work"'), "work");
  });

  // Strict on purpose: a typo, or a key nobody implements, must not run as something else.
  const invalid: ReadonlyArray<readonly [name: string, text: string, problem: RegExp]> = [
    ["Standup", file("timezone: UTC\ntime: 09:00"), /lowercase letters, digits and hyphens/],
    ["stand_up", file("timezone: UTC\ntime: 09:00"), /lowercase letters/],
    ["standup", "timezone: UTC\ntime: 09:00\n\nHello", /front matter/],
    ["standup", "---\ntimezone: UTC\ntime: 09:00\nHello", /front matter/],
    ["standup", file("timezone: UTC\ntime: 09:00\nenabled: false"), /`enabled` is no key/],
    ["standup", file("timezone: UTC\ntme: 09:00"), /`tme` is no key/],
    ["standup", file("timezone: UTC\ntime: 09:00\ntime: 10:00"), /`time` is given twice/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndays:\n  - mon"), /line "  - mon"/],
    ["standup", file("timezone: UTC\n# a comment\ntime: 09:00"), /line "# a comment"/],
    ["standup", file("time: 09:00"), /no `timezone`/],
    ["standup", file("timezone: Mars/Olympus\ntime: 09:00"), /no IANA time zone/],
    ["standup", file("timezone: UTC\ntime: 09:00", "  \n"), /its message.* is empty/],
    ["standup", file("timezone: UTC"), /neither `time` nor `every`/],
    ["standup", file("timezone: UTC\ntime: 09:00\nevery: 1h"), /both `time` and `every`/],
    ["standup", file("timezone: UTC\nevery: 1h\ndays: [mon]"), /go with `time`/],
    ["standup", file("timezone: UTC\nevery: 1h\ndate: 2026-11-12"), /go with `time`/],
    ["standup", file("timezone: UTC\nevery: 45m"), /`every` "45m" is not one of/],
    ["standup", file("timezone: UTC\nevery: 24h"), /`every` "24h"/],
    ["standup", file("timezone: UTC\nevery: 5m"), /`every` "5m"/],
    ["standup", file("timezone: UTC\ntime: 9:00"), /`time` "9:00" is not HH:MM/],
    ["standup", file("timezone: UTC\ntime: 24:00"), /`time` "24:00"/],
    ["standup", file("timezone: UTC\ntime: 09:60"), /`time` "09:60"/],
    [
      "standup",
      file("timezone: UTC\ntime: 09:00\ndays: [mon]\ndate: 2026-11-12"),
      /both `days` and `date`/,
    ],
    ["standup", file("timezone: UTC\ntime: 09:00\ndate: 2026-02-30"), /`date` "2026-02-30"/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndate: 12/11/2026"), /`date` "12\/11\/2026"/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndays: mon"), /`days` "mon" is not a list/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndays: []"), /`days` "\[\]"/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndays: [monday]"), /`days` "\[monday\]"/],
    ["standup", file("timezone: UTC\ntime: 09:00\ndays: [mon, mon]"), /each once/],
    [
      "standup",
      file("timezone: UTC\ntime: 09:00\nto: Work"),
      /`to` "Work" is neither user nor work/,
    ],
    ["standup", file("timezone: UTC\ntime: 09:00\nto: me"), /`to` "me"/],
    ["standup", file("timezone: UTC\ntime: 09:00\nto:"), /`to` "" is neither/],
    ["standup", file("timezone: UTC\ntime: 09:00\nto: work\nto: user"), /`to` is given twice/],
  ];
  it.each(invalid)("finds %j %j no schedule", (name, text, expected) => {
    const parsed = parseSchedule(name, text);
    assert.isFalse(parsed.ok);
    if (!parsed.ok) assert.match(parsed.problem, expected);
  });
});

describe("scheduleName", () => {
  it("is the name of a .md file without it, and none for any other", () => {
    assert.strictEqual(scheduleName("standup.md"), "standup");
    assert.strictEqual(scheduleName("Standup.md"), "Standup");
    assert.strictEqual(scheduleName(".md"), undefined);
    assert.strictEqual(scheduleName(".#standup.md"), undefined);
    assert.strictEqual(scheduleName(".standup.md"), undefined);
    assert.strictEqual(scheduleName("standup.md.swp"), undefined);
    assert.strictEqual(scheduleName("notes.txt"), undefined);
  });
});

const schedule = (matter: string): Schedule => {
  const parsed = parseSchedule("s", file(matter));
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.schedule;
};
const ms = (iso: string) => Date.parse(iso);
const isoOf = (at: number | undefined) =>
  at === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(at));
const dues = (s: Schedule, at: string) => ({
  latest: isoOf(latestDue(s, ms(at))),
  next: isoOf(nextDue(s, ms(at))),
});

// New York leaves daylight saving at 02:00 on 2026-11-01, back to 01:00, and enters it at 02:00
// on 2026-03-08, on to 03:00. 2026-11-10 is a Tuesday.
describe("latestDue and nextDue", () => {
  it("daily, around the end of daylight saving", () => {
    const daily = schedule("timezone: America/New_York\ntime: 09:00");
    assert.deepStrictEqual(dues(daily, "2026-11-10T15:00:00Z"), {
      latest: "2026-11-10T14:00:00.000Z",
      next: "2026-11-11T14:00:00.000Z",
    });
    // On the day it ends, 09:00 is in standard time; the day before in daylight time.
    assert.deepStrictEqual(dues(daily, "2026-11-01T12:00:00Z"), {
      latest: "2026-10-31T13:00:00.000Z",
      next: "2026-11-01T14:00:00.000Z",
    });
    // At the due minute itself, it is the latest.
    assert.strictEqual(dues(daily, "2026-11-10T14:00:00Z").latest, "2026-11-10T14:00:00.000Z");
  });

  it("on days, across a week", () => {
    const mondaysAndFridays = schedule("timezone: America/New_York\ntime: 09:00\ndays: [mon, fri]");
    assert.deepStrictEqual(dues(mondaysAndFridays, "2026-11-10T15:00:00Z"), {
      latest: "2026-11-09T14:00:00.000Z",
      next: "2026-11-13T14:00:00.000Z",
    });
    const sundays = schedule("timezone: America/New_York\ntime: 09:00\ndays: [sun]");
    assert.deepStrictEqual(dues(sundays, "2026-11-08T13:59:00Z"), {
      latest: "2026-11-01T14:00:00.000Z",
      next: "2026-11-08T14:00:00.000Z",
    });
  });

  it("once, before and after its time", () => {
    const once = schedule("timezone: America/New_York\ntime: 10:00\ndate: 2026-11-12");
    assert.deepStrictEqual(dues(once, "2026-11-12T14:59:00Z"), {
      latest: undefined,
      next: "2026-11-12T15:00:00.000Z",
    });
    assert.deepStrictEqual(dues(once, "2026-11-20T00:00:00Z"), {
      latest: "2026-11-12T15:00:00.000Z",
      next: undefined,
    });
  });

  it("every, from midnight in the zone, the repeated hour once", () => {
    const twoHours = schedule("timezone: America/New_York\nevery: 2h");
    assert.deepStrictEqual(dues(twoHours, "2026-11-10T15:30:00Z"), {
      latest: "2026-11-10T15:00:00.000Z",
      next: "2026-11-10T17:00:00.000Z",
    });
    // 22:00 then midnight, across the date.
    assert.deepStrictEqual(dues(twoHours, "2026-11-11T04:30:00Z"), {
      latest: "2026-11-11T03:00:00.000Z",
      next: "2026-11-11T05:00:00.000Z",
    });
    // 01:00 is the earlier of its two instants; 01:30 standard time is past it.
    const hourly = schedule("timezone: America/New_York\nevery: 1h");
    assert.deepStrictEqual(dues(hourly, "2026-11-01T06:30:00Z"), {
      latest: "2026-11-01T05:00:00.000Z",
      next: "2026-11-01T07:00:00.000Z",
    });
  });

  it("a time in the spring gap is the instant after it", () => {
    const daily = schedule("timezone: America/New_York\ntime: 02:30");
    assert.deepStrictEqual(dues(daily, "2026-03-08T12:00:00Z"), {
      latest: "2026-03-08T07:30:00.000Z",
      next: "2026-03-09T06:30:00.000Z",
    });
    const halfHourly = schedule("timezone: America/New_York\nevery: 30m");
    assert.deepStrictEqual(dues(halfHourly, "2026-03-08T06:45:00Z"), {
      latest: "2026-03-08T06:30:00.000Z",
      next: "2026-03-08T07:00:00.000Z",
    });
  });
});

describe("minuteOf and wallClock", () => {
  it("floors to the minute, and shows an instant on the zone's clock", () => {
    assert.strictEqual(minuteOf(ms("2026-11-10T12:00:59.999Z")), ms("2026-11-10T12:00:00Z"));
    const zone = schedule("timezone: America/Argentina/Buenos_Aires\ntime: 09:00").zone;
    assert.strictEqual(wallClock(zone, ms("2026-11-10T12:00:00Z")), "2026-11-10 09:00");
  });
});
