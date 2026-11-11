import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { DateTime, Effect, FileSystem, Layer, Path, ServerConfig } from "../host.ts";
import type { Deliver, Delivered, Delivery } from "../stars/deliver.ts";
import type { Star, StarsView } from "../stars/stars.ts";
import { fakeServer } from "../stars/testing.ts";
import * as Schedules from "./schedules.ts";

const STANDUP = `---
timezone: UTC
time: "09:00"
---
Time for the standup.
`;

/**
 * One Star over a fake server, and the schedules over a fake `deliver` that launches a message
 * the first time its key is seen and replays it after; `pass` runs the source as the tick would.
 */
const harness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-10T08:00:00Z"));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* fakeServer;
  const root = path.join(server.directory, "star");
  yield* fs.makeDirectory(root, { recursive: true });
  const star: Star = {
    id: "star-1",
    name: "",
    tint: "amber",
    created: "2026-11-01T00:00:00.000Z",
    root,
    projectId: ProjectId.make("project-1"),
  };
  const deliveries: Delivery[] = [];
  const keys = new Set<string>();
  const behaviour: { fail: string | undefined } = { fail: undefined };
  const deliver: Deliver = (delivery) =>
    Effect.suspend(() => {
      deliveries.push(delivery);
      if (behaviour.fail !== undefined)
        return Effect.fail(
          new OrchestratorMcpFailure({ code: "thread_not_found", message: behaviour.fail }),
        );
      const replayed = keys.has(delivery.key);
      keys.add(delivery.key);
      return Effect.succeed<Delivered>(
        replayed
          ? { outcome: "replayed", threadId: null }
          : { outcome: "launched", threadId: ThreadId.make(`thread-${keys.size}`) },
      );
    });
  const schedules = yield* Schedules.make(
    { directory: server.directory, list: Effect.succeed([star]) },
    deliver,
  ).pipe(Effect.provide(server.layer));
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(server.layer));

  const pass = server.runSource("pult-schedules");
  const clock = (iso: string) => TestClock.setTime(Date.parse(iso));
  const scheduleFile = (name: string) => path.join(root, ".pult", "schedules", `${name}.md`);
  /** Writes the schedule as of `changed`, its modification time. */
  const write = (name: string, text: string, changed: string) =>
    Effect.gen(function* () {
      const file = scheduleFile(name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
      // A number would be read as seconds.
      const at = DateTime.toDate(DateTime.makeUnsafe(changed));
      yield* fs.utimes(file, at, at);
    });
  const runFile = (name: string, due: string) => path.join(root, ".pult", "runs", name, due);
  const records = (name: string) =>
    Effect.gen(function* () {
      const folder = path.join(root, ".pult", "runs", name);
      return (yield* fs.exists(folder)) ? (yield* fs.readDirectory(folder)).toSorted() : [];
    });
  const starView: StarsView["stars"][number] = {
    ...star,
    instructions: path.join(root, "instructions.md"),
    conversation: null,
    asleepSince: star.created,
    conversations: [],
    asks: [],
  };
  const view = Effect.map(
    schedules.withSchedules({ directory: server.directory, hidden: [], stars: [starView] }),
    (each) => each.stars[0]?.schedules ?? [],
  );
  /** A batch from the watch of the Stars directory, handed to the plugin's subscriber. */
  const changed = (paths: ReadonlyArray<string>, truncated = false) =>
    Effect.gen(function* () {
      const watch = server.watches.at(-1);
      if (watch === undefined) return yield* Effect.die(new Error("no watch"));
      yield* Queue.offer(watch.queue, {
        changes: paths.map((each) => ({ path: each, kind: "changed" as const })),
        truncated,
      });
      yield* Effect.yieldNow;
    });
  return {
    ...server,
    fs,
    path,
    star,
    deliveries,
    behaviour,
    schedules,
    config,
    pass,
    clock,
    write,
    scheduleFile,
    runFile,
    records,
    view,
    changed,
  };
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

describe("namesSchedules", () => {
  it("is a Star's folder, its .pult, its schedules and its record, and nothing else", () => {
    for (const changed of [
      "star",
      "star/.pult",
      "star/.pult/schedules",
      "star/.pult/schedules/standup.md",
      "star/.pult/star.yaml",
    ])
      assert.isTrue(Schedules.namesSchedules(changed), changed);
    for (const changed of [
      "star/.pult/runs/standup/2026-11-10T09-00Z.yaml",
      "star/.pult/conversations/env-1/a.md",
      "star/.pult/asks/a.md",
      "star/instructions.md",
      "star/notes/.pult/schedules/a.md",
    ])
      assert.isFalse(Schedules.namesSchedules(changed), changed);
  });
});

describe("the pass", () => {
  it.effect("fires a due run once, as the plugin, and records it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 0);

      yield* h.clock("2026-11-10T09:00:04Z");
      yield* h.pass;
      assert.deepStrictEqual(h.deliveries, [
        {
          star: h.star,
          text: "Time for the standup.",
          from: "schedule standup, due 2026-11-10 09:00 UTC",
          key: "schedule:standup:2026-11-10T09:00:00.000Z",
          sender: "plugin",
        },
      ]);
      assert.strictEqual(
        yield* h.fs.readFileString(h.runFile("standup", "2026-11-10T09-00Z.yaml")),
        [
          'schedule: "standup"',
          'due: "2026-11-10T09:00:00.000Z"',
          'environment: "env-1"',
          'fired: "2026-11-10T09:00:04.000Z"',
          "result: launched",
          'thread: "thread-1"',
          "",
        ].join("\n"),
      );

      // Read back on the next tick, and never fired again.
      yield* h.clock("2026-11-10T09:00:09Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T09:30:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      const [standup] = yield* h.view;
      assert.deepStrictEqual(standup, {
        name: "standup",
        path: h.scheduleFile("standup"),
        rule: "every day 09:00",
        timezone: "UTC",
        next: "2026-11-11T09:00:00.000Z",
        spent: false,
        problem: null,
        last: {
          due: "2026-11-10T09:00:00.000Z",
          fired: "2026-11-10T09:00:04.000Z",
          result: "launched",
          error: null,
          thread: "thread-1",
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("fires the latest missed run late, saying how late, and no older one", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-07T08:00:00Z");
      yield* h.clock("2026-11-10T10:30:00Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.from),
        ["schedule standup, due 2026-11-10 09:00 UTC, delivered 1h 30m late"],
      );
      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T09-00Z.yaml"]);
    }).pipe(Effect.scoped),
  );

  it.effect("holds to the floor: nothing due before the minute the file last changed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-10T09:00:30Z");
      yield* h.clock("2026-11-10T09:00:40Z");
      yield* h.pass;
      // Written in the due minute: it fires.
      assert.strictEqual(h.deliveries.length, 1);

      yield* h.write("late", STANDUP, "2026-11-10T09:01:00Z");
      yield* h.changed(["star/.pult/schedules/late.md"]);
      yield* h.clock("2026-11-10T09:01:05Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      assert.deepStrictEqual(yield* h.records("late"), []);

      // Its first run is the next one, read at its due time.
      yield* h.clock("2026-11-11T09:00:02Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.slice(1).map((each) => each.key),
        ["schedule:late:2026-11-11T09:00:00.000Z", "schedule:standup:2026-11-11T09:00:00.000Z"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fires a run whose record was lost again, which the key replays", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T09:00:06Z");
      yield* h.pass;
      yield* h.fs.remove(h.runFile("standup", "2026-11-10T09-00Z.yaml"));
      // Nothing tells of a record's loss: the ten-minute read finds it.
      yield* h.clock("2026-11-10T09:10:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      yield* h.clock("2026-11-10T09:10:06Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        ["schedule:standup:2026-11-10T09:00:00.000Z", "schedule:standup:2026-11-10T09:00:00.000Z"],
      );
      assert.include(
        yield* h.fs.readFileString(h.runFile("standup", "2026-11-10T09-00Z.yaml")),
        "result: replayed\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("records a failed delivery and does not retry it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.behaviour.fail = "The Star has had no conversation on this server.";
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T09:00:06Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T09:20:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      const [standup] = yield* h.view;
      assert.deepStrictEqual(standup?.last, {
        due: "2026-11-10T09:00:00.000Z",
        fired: "2026-11-10T09:00:01.000Z",
        result: "failed",
        error: "The Star has had no conversation on this server.",
        thread: null,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not fire a run again whose record failed to write, and logs it as an error",
    () => {
      const errors: unknown[] = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Error") errors.push(message);
      });
      return Effect.gen(function* () {
        const h = yield* harness;
        yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
        const runs = h.path.dirname(h.runFile("standup", "x"));
        yield* h.fs.makeDirectory(runs, { recursive: true });
        yield* h.fs.chmod(runs, 0o555);
        for (const at of ["09:00:01", "09:00:06", "09:00:11", "09:20:00"]) {
          yield* h.clock(`2026-11-10T${at}Z`);
          yield* h.pass;
        }
        assert.strictEqual(h.deliveries.length, 1);
        assert.deepStrictEqual(yield* h.records("standup"), []);
        assert.lengthOf(errors, 1);
        const [text, fields] = errors[0] as [string, Record<string, unknown>];
        assert.match(text, /^Could not record a Star's scheduled run/);
        assert.deepInclude(fields, {
          starId: "star-1",
          schedule: "standup",
          due: "2026-11-10T09:00:00.000Z",
          result: "launched",
        });
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  it.effect("tells a file that is no schedule to the Star once per content", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const typo = STANDUP.replace("time:", "tme:");
      yield* h.write("standup", typo, "2026-11-10T08:00:00Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T08:10:00Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 1);
      const [told] = h.deliveries;
      assert.strictEqual(told?.from, "Pult, about schedule standup");
      assert.strictEqual(
        told?.text,
        "`.pult/schedules/standup.md` will not run: `tme` is no key of a schedule's; they are timezone, time, days, date and every. Fix the file or delete it; Pult tells you once per content.",
      );
      assert.match(told?.key ?? "", /^schedule-problem:standup:[0-9a-f]{16}$/);
      const [standup] = yield* h.view;
      assert.deepInclude(standup, { rule: null, timezone: null, next: null, spent: false });
      assert.match(standup?.problem ?? "", /`tme` is no key/);

      // Another content is told again; the same content again is not.
      yield* h.write("standup", typo.replace("09:00", "10:00"), "2026-11-10T08:11:00Z");
      yield* h.changed(["star/.pult/schedules/standup.md"]);
      yield* h.clock("2026-11-10T08:11:05Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 2);
      assert.notStrictEqual(h.deliveries[1]?.key, told?.key);
      yield* h.write("standup", typo, "2026-11-10T08:12:00Z");
      yield* h.changed(["star/.pult/schedules/standup.md"]);
      yield* h.clock("2026-11-10T08:12:05Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("fires a one-off once and leaves its file, spent; one written too late is told", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const once = STANDUP.replace('time: "09:00"', 'time: "09:00"\ndate: 2026-11-10');
      yield* h.write("once", once, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      yield* h.clock("2026-11-11T09:00:01Z");
      yield* h.pass;
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.key),
        ["schedule:once:2026-11-10T09:00:00.000Z"],
      );
      assert.isTrue(yield* h.fs.exists(h.scheduleFile("once")));
      const [spent] = yield* h.view;
      assert.deepInclude(spent, {
        rule: "once, 10 Nov 09:00",
        next: null,
        spent: true,
        problem: null,
      });

      yield* h.write("missed", once, "2026-11-11T09:00:00Z");
      yield* h.changed(["star/.pult/schedules/missed.md"]);
      yield* h.clock("2026-11-11T09:00:06Z");
      yield* h.pass;
      assert.strictEqual(h.deliveries.length, 2);
      assert.strictEqual(h.deliveries[1]?.from, "Pult, about schedule missed");
      assert.include(
        h.deliveries[1]?.text ?? "",
        "it is a one-off for 2026-11-10 09:00 UTC, which had passed when the file was written",
      );
      assert.deepStrictEqual(yield* h.records("missed"), []);
    }).pipe(Effect.scoped),
  );

  it.effect("fires and tells nothing while schedules-off exists", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const off = h.path.join(h.config.stateDir, "plugins", "pult", "schedules-off");
      yield* h.fs.makeDirectory(h.path.dirname(off), { recursive: true });
      yield* h.fs.writeFileString(off, "");
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.write("typo", STANDUP.replace("time:", "tme:"), "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      assert.isFalse(yield* h.schedules.firing);
      assert.strictEqual(h.deliveries.length, 0);
      assert.deepStrictEqual(yield* h.records("standup"), []);
      // The page still sees them.
      assert.deepStrictEqual(
        (yield* h.view).map((each) => each.name),
        ["standup", "typo"],
      );

      // Looked for at each read: removed, the run fires late with no restart.
      yield* h.fs.remove(off);
      yield* h.clock("2026-11-10T09:11:00Z");
      yield* h.pass;
      assert.isTrue(yield* h.schedules.firing);
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.from),
        [
          "schedule standup, due 2026-11-10 09:00 UTC, delivered 11m late",
          "Pult, about schedule typo",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reads again when the watch names a schedule", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.pass;
      assert.strictEqual(h.watches.length, 1);
      assert.strictEqual(h.watches[0]?.cwd, h.directory);

      // A file the plugin was not told of is not read on an idle tick.
      yield* h.write("standup", STANDUP.replace("09:00", "08:00"), "2026-11-10T07:00:00Z");
      yield* h.clock("2026-11-10T08:05:00Z");
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("standup"), []);
      // A change elsewhere in the folder tells of nothing.
      yield* h.changed(["star/notes.md", "star/.pult/runs/standup/x.yaml"]);
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("standup"), []);
      yield* h.changed(["star/.pult/schedules/standup.md"]);
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T08-00Z.yaml"]);

      // A truncated batch may hold anything; the tick after the run reads its record back first.
      yield* h.pass;
      yield* h.write("other", STANDUP.replace("09:00", "08:00"), "2026-11-10T07:00:00Z");
      yield* h.clock("2026-11-10T08:05:05Z");
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("other"), []);
      yield* h.changed([], true);
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("other"), ["2026-11-10T08-00Z.yaml"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads again ten minutes after the last read, told of nothing", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.pass;
      yield* h.write("standup", STANDUP.replace("09:00", "08:00"), "2026-11-10T07:00:00Z");
      yield* h.clock("2026-11-10T08:09:59Z");
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("standup"), []);
      yield* h.clock("2026-11-10T08:10:00Z");
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T08-00Z.yaml"]);
    }).pipe(Effect.scoped),
  );

  it.effect("subscribes the watch again once it ended, and reads on the way", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.pass;
      const [first] = h.watches;
      yield* h.write("standup", STANDUP.replace("09:00", "08:00"), "2026-11-10T07:00:00Z");
      yield* Queue.end(first!.queue);
      yield* Effect.yieldNow;
      yield* h.clock("2026-11-10T08:00:05Z");
      yield* h.pass;
      assert.strictEqual(h.watches.length, 2);
      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T08-00Z.yaml"]);
    }).pipe(Effect.scoped),
  );

  it.effect("watches the Stars directory from the first tick it is there, and reads then", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.fs.remove(h.directory, { recursive: true });
      yield* h.pass;
      yield* h.clock("2026-11-10T08:00:05Z");
      yield* h.pass;
      assert.strictEqual(h.watches.length, 0);
      yield* h.write("standup", STANDUP.replace("09:00", "08:00"), "2026-11-10T07:00:00Z");
      yield* h.clock("2026-11-10T08:00:10Z");
      yield* h.pass;
      assert.strictEqual(h.watches.length, 1);
      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T08-00Z.yaml"]);
    }).pipe(Effect.scoped),
  );
});
