// Run with `node --test src/stars/schedules.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { RouteSchedule } from "./plugin.ts";
import { cityOf, instantText, scheduleRows } from "./schedules.ts";

const BUENOS_AIRES = "America/Argentina/Buenos_Aires";
// 2026-11-11 10:00 in Buenos Aires (UTC-3).
const NOW = Date.parse("2026-11-11T13:00:00.000Z");

const schedule = (overrides: Partial<RouteSchedule> = {}): RouteSchedule => ({
  name: "morning",
  path: "/s/.pult/schedules/morning.md",
  rule: "weekdays 09:00",
  timezone: BUENOS_AIRES,
  next: "2026-11-12T12:00:00.000Z",
  spent: false,
  problem: null,
  last: null,
  ...overrides,
});

NodeTest.describe("instantText", () => {
  NodeTest.test("names the day by the page's zone", () => {
    const at = (iso: string) => instantText(iso, NOW, BUENOS_AIRES);
    NodeAssert.equal(at("2026-11-11T12:00:00.000Z"), "today 09:00");
    NodeAssert.equal(at("2026-11-12T12:00:00.000Z"), "tomorrow 09:00");
    NodeAssert.equal(at("2026-11-10T23:30:00.000Z"), "yesterday 20:30");
    NodeAssert.equal(at("2026-11-20T12:00:00.000Z"), "20 Nov 09:00");
    NodeAssert.equal(at("2027-01-02T12:00:00.000Z"), "2 Jan 2027 09:00");
  });

  NodeTest.test("counts days in the zone, not in UTC", () => {
    // 02:00 UTC on the 12th is still the 11th in Buenos Aires.
    NodeAssert.equal(instantText("2026-11-12T02:00:00.000Z", NOW, BUENOS_AIRES), "today 23:00");
    NodeAssert.equal(instantText("2026-11-12T02:00:00.000Z", NOW, "UTC"), "tomorrow 02:00");
  });
});

NodeTest.describe("cityOf", () => {
  NodeTest.test("reads the zone's last segment in words", () => {
    NodeAssert.equal(cityOf(BUENOS_AIRES), "Buenos Aires");
    NodeAssert.equal(cityOf("Europe/London"), "London");
    NodeAssert.equal(cityOf("UTC"), "UTC");
  });
});

NodeTest.describe("scheduleRows", () => {
  const row = (overrides: Partial<RouteSchedule>, zone = BUENOS_AIRES) => {
    const [only] = scheduleRows([schedule(overrides)], NOW, zone);
    if (only === undefined) throw new Error("no row");
    return only;
  };

  NodeTest.test("adds the city only where the schedule's zone is not the page's", () => {
    NodeAssert.equal(row({}).rule, "weekdays 09:00");
    NodeAssert.equal(row({}, "Europe/London").rule, "weekdays 09:00 (Buenos Aires)");
    NodeAssert.equal(row({ timezone: "Etc/UTC" }, "UTC").rule, "weekdays 09:00");
  });

  NodeTest.test("formats the next run in the page's zone", () => {
    NodeAssert.equal(row({}).next, "tomorrow 09:00");
    NodeAssert.equal(row({}, "Europe/London").next, "tomorrow 12:00");
    NodeAssert.equal(row({ next: null }).next, undefined);
  });

  NodeTest.test("says how the last run went, a failure's error its detail", () => {
    NodeAssert.deepEqual([row({}).last, row({}).warning], ["not run yet", false]);
    const ran = row({
      last: {
        due: "2026-11-11T12:00:00.000Z",
        fired: "2026-11-11T12:00:04.000Z",
        result: "queued",
        error: null,
        thread: "t1",
      },
    });
    NodeAssert.deepEqual(
      [ran.last, ran.detail, ran.warning],
      ["ran today 09:00", undefined, false],
    );
    const failed = row({
      last: {
        due: "2026-11-10T12:00:00.000Z",
        fired: "2026-11-10T12:00:04.000Z",
        result: "failed",
        error: "no conversation ended here yet",
        thread: null,
      },
    });
    NodeAssert.deepEqual(
      [failed.last, failed.detail, failed.warning],
      ["failed yesterday 09:00", "no conversation ended here yet", true],
    );
  });

  NodeTest.test("tells a file that is no schedule from one that will not run", () => {
    const typo = row({ rule: null, timezone: null, next: null, problem: "it has no `timezone`" });
    NodeAssert.deepEqual(
      [typo.rule, typo.last, typo.warning],
      [undefined, "not a schedule: it has no `timezone`", true],
    );
    const passed = row({ rule: "once, 1 Nov 09:00", next: null, problem: "it had passed" });
    NodeAssert.deepEqual(
      [passed.rule, passed.last, passed.warning],
      ["once, 1 Nov 09:00", "will not run: it had passed", true],
    );
  });

  NodeTest.test("keeps a spent one-off's mark for the card to dim", () => {
    NodeAssert.equal(row({ rule: "once, 11 Nov 09:00", next: null, spent: true }).spent, true);
    NodeAssert.equal(row({}).spent, false);
  });
});
