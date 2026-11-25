import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { DateTime, Effect, FileSystem, Layer, Option, Path, ServerConfig } from "../host.ts";
import type { Deliver, Delivered, Delivery } from "../stars/deliver.ts";
import type { Star, StarsView } from "../stars/stars.ts";
import { fakeServer } from "../stars/testing.ts";
import type { CommandOutcome, RunCommand } from "./command.ts";
import * as Schedules from "./schedules.ts";

const STANDUP = `---
timezone: UTC
time: "09:00"
---
Time for the standup.
`;

/**
 * One Star over a fake server, and the schedules over a fake `deliver` that launches a message
 * the first time its key is seen and replays it after, and a fake `runCommand` that is what
 * `outcomes` says for its command, silent where it says nothing; `pass` runs the source as the tick would.
 * The schedules see the file system as `fileSystem` makes it of the real one.
 */
const harnessWith = (
  fileSystem: (fs: FileSystem.FileSystem) => FileSystem.FileSystem = (fs) => fs,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T08:00:00Z"));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const server = yield* fakeServer;
    const root = path.join(server.directory, "star");
    yield* fs.makeDirectory(root, { recursive: true });
    const star: Star = {
      id: "star-1",
      name: "",
      description: "",
      tint: "amber",
      created: "2026-11-01T00:00:00.000Z",
      defaultChannel: "main",
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
    const commands: Array<{ readonly root: string; readonly command: string }> = [];
    const outcomes = new Map<string, CommandOutcome>();
    const runCommand: RunCommand = (root, command) =>
      Effect.sync(() => {
        commands.push({ root, command });
        return outcomes.get(command) ?? { kind: "silent" };
      });
    const schedules = yield* Schedules.make(
      { directory: server.directory, list: Effect.succeed([star]) },
      deliver,
      runCommand,
    ).pipe(
      Effect.provide(server.layer),
      Effect.provideService(FileSystem.FileSystem, fileSystem(fs)),
    );
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
      channels: [],
      asleepSince: star.created,
      model: null,
      conversations: [],
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
      commands,
      outcomes,
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

const harness = harnessWith();

const WATCHER = `---
timezone: UTC
every: 15m
to: mail
run: ./watch.sh
---
New mail came in.
`;

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
      "star/.pult/channels/user/conversations/env-1/a.md",
      "star/.pult/asks/a.md",
      "star/instructions.md",
      "star/notes/.pult/schedules/a.md",
    ])
      assert.isFalse(Schedules.namesSchedules(changed), changed);
  });
});

describe("the pass", () => {
  it.effect("delivers a run to the channel its schedule names, none where it names none", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.write(
        "watch",
        "---\ntimezone: UTC\ntime: 09:00\nto: work\n---\nCheck the build.\n",
        "2026-11-10T08:00:00Z",
      );
      yield* h.write(
        "release",
        "---\ntimezone: UTC\ntime: 09:00\nto: release-42\n---\nShip it.\n",
        "2026-11-10T08:00:00Z",
      );
      yield* h.clock("2026-11-10T09:00:04Z");
      yield* h.pass;
      assert.deepStrictEqual(h.deliveries.map((each) => [each.text, each.to]).toSorted(), [
        ["Check the build.", "work"],
        ["Ship it.", "release-42"],
        ["Time for the standup.", undefined],
      ]);
    }).pipe(Effect.scoped),
  );

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
          to: undefined,
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
        title: null,
        path: h.scheduleFile("standup"),
        rule: "every day 09:00",
        kind: "daily",
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
      // A file that is no schedule names no channel: it lands in the default channel.
      assert.strictEqual(told?.to, undefined);
      assert.strictEqual(
        told?.text,
        "`.pult/schedules/standup.md` will not run: `tme` is no key of a schedule's; they are timezone, time, days, date, every, to, run and title. Fix the file or delete it; Pult tells you once per content.",
      );
      assert.match(told?.key ?? "", /^schedule-problem:standup:[0-9a-f]{16}$/);
      const [standup] = yield* h.view;
      assert.deepInclude(standup, {
        rule: null,
        kind: null,
        timezone: null,
        next: null,
        spent: false,
      });
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

  it.effect("makes a file that fails to read, or whose runs do, a problem of its own", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("standup", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.fs.symlink("nowhere.md", h.scheduleFile("dangling"));
      // Emacs's lock file, a symlink to nothing, is a dot-file and no schedule: never told.
      yield* h.fs.symlink("anton@host.1234", h.scheduleFile(".#standup"));
      yield* h.write("locked", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.fs.chmod(h.scheduleFile("locked"), 0o000);
      yield* h.write("filed", STANDUP, "2026-11-10T08:00:00Z");
      const filed = h.path.dirname(h.runFile("filed", "x"));
      yield* h.fs.makeDirectory(h.path.dirname(filed), { recursive: true });
      yield* h.fs.writeFileString(filed, "");
      yield* h.write("malformed", STANDUP.replace("timezone: UTC\n", ""), "2026-11-10T08:00:00Z");
      yield* h.fs.writeFileString(h.path.dirname(h.runFile("malformed", "x")), "");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;

      assert.deepStrictEqual(yield* h.records("standup"), ["2026-11-10T09-00Z.yaml"]);
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.from),
        [
          "Pult, about schedule dangling",
          "Pult, about schedule filed",
          "Pult, about schedule locked",
          "Pult, about schedule malformed",
          "schedule standup, due 2026-11-10 09:00 UTC",
        ],
      );
      assert.match(
        h.deliveries.find((each) => each.from === "Pult, about schedule malformed")?.text ?? "",
        /it has no `timezone`/,
      );
      const view = yield* h.view;
      const blocked = view.find((each) => each.name === "filed");
      assert.strictEqual(blocked?.timezone, "UTC");
      assert.strictEqual(blocked?.next, null);
      assert.deepStrictEqual(
        view.map((each) => [each.name, each.rule, each.problem?.split(":")[0] ?? null]),
        [
          ["dangling", null, "it could not be read"],
          ["filed", "every day 09:00", "its runs, `.pult/runs/filed`, could not be read"],
          ["locked", null, "it could not be read"],
          ["malformed", null, "it has no `timezone`, an IANA name"],
          ["standup", "every day 09:00", null],
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("makes a file with no modification time a problem, its floor unknown", () =>
    Effect.gen(function* () {
      const h = yield* harnessWith((fs) => ({
        ...fs,
        stat: (file) =>
          Effect.map(fs.stat(file), (info) =>
            file.endsWith("timeless.md") ? { ...info, mtime: Option.none() } : info,
          ),
      }));
      yield* h.write("timeless", STANDUP, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      assert.deepStrictEqual(yield* h.records("timeless"), []);
      assert.deepStrictEqual(
        h.deliveries.map((each) => each.from),
        ["Pult, about schedule timeless"],
      );
      const [timeless] = yield* h.view;
      assert.deepInclude(timeless, {
        rule: null,
        next: null,
        problem:
          "the file system gives it no modification time, which its first run is counted from",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("fires a one-off once and leaves its file, spent; one written too late is told", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const once = STANDUP.replace(
        'time: "09:00"',
        'time: "09:00"\ndate: 2026-11-10\ntitle: Release check',
      );
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
        title: "Release check",
        rule: "once, 10 Nov 09:00",
        kind: "once",
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
      yield* h.write("mail", WATCHER, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T09:00:01Z");
      yield* h.pass;
      assert.isFalse(yield* h.schedules.firing);
      assert.strictEqual(h.deliveries.length, 0);
      assert.deepStrictEqual(h.commands, []);
      assert.deepStrictEqual(yield* h.records("standup"), []);
      // The page still sees them.
      assert.deepStrictEqual(
        (yield* h.view).map((each) => each.name),
        ["mail", "standup", "typo"],
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

  it.effect(
    "delivers a watcher's printed run, its message then the output, once, and records it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.outcomes.set("./watch.sh", { kind: "printed", output: "From: a@example.com\n" });
        yield* h.write("mail", WATCHER, "2026-11-10T08:00:00Z");
        yield* h.clock("2026-11-10T08:15:30Z");
        yield* h.pass;
        assert.deepStrictEqual(h.commands, [{ root: h.star.root, command: "./watch.sh" }]);
        assert.deepStrictEqual(h.deliveries, [
          {
            star: h.star,
            text: "New mail came in.\n\nFrom: a@example.com\n",
            from: "schedule mail's command, ran 2026-11-10 08:15 UTC",
            key: "schedule:mail:2026-11-10T08:15:00.000Z",
            to: "mail",
            sender: "plugin",
          },
        ]);
        // Read back on the next tick, and not run again until the next due time.
        yield* h.clock("2026-11-10T08:15:35Z");
        yield* h.pass;
        yield* h.clock("2026-11-10T08:29:00Z");
        yield* h.pass;
        assert.strictEqual(h.commands.length, 1);
        assert.strictEqual(h.deliveries.length, 1);
        const [mail] = yield* h.view;
        assert.deepInclude(mail, {
          rule: "every 15m, runs ./watch.sh",
          kind: "every",
          last: {
            due: "2026-11-10T08:15:00.000Z",
            fired: "2026-11-10T08:15:30.000Z",
            result: "launched",
            error: null,
            thread: "thread-1",
          },
        });
      }).pipe(Effect.scoped),
  );

  it.effect("delivers and records nothing for a silent run, and runs it again only when due", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write("mail", WATCHER, "2026-11-10T08:00:00Z");
      yield* h.clock("2026-11-10T08:15:01Z");
      yield* h.pass;
      yield* h.clock("2026-11-10T08:15:06Z");
      yield* h.pass;
      // The ten-minute read finds no record, and still does not run it again.
      yield* h.clock("2026-11-10T08:25:06Z");
      yield* h.pass;
      assert.strictEqual(h.commands.length, 1);
      yield* h.clock("2026-11-10T08:30:01Z");
      yield* h.pass;
      assert.strictEqual(h.commands.length, 2);
      assert.deepStrictEqual(h.deliveries, []);
      assert.deepStrictEqual(yield* h.records("mail"), []);
      const [mail] = yield* h.view;
      assert.strictEqual(mail?.last, null);
    }).pipe(Effect.scoped),
  );

  it.effect("records a failed run and tells its channel once, until a clean run, then again", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const failed: CommandOutcome = { kind: "failed", error: "exited 2\nno such mailbox" };
      h.outcomes.set("./watch.sh", failed);
      yield* h.write("mail", WATCHER, "2026-11-10T08:00:00Z");
      for (const at of ["08:15:01", "08:30:01", "08:45:01", "09:00:01", "09:15:01"]) {
        // Clean at 08:45 only.
        h.outcomes.set("./watch.sh", at === "08:45:01" ? { kind: "silent" } : failed);
        yield* h.clock(`2026-11-10T${at}Z`);
        yield* h.pass;
      }
      assert.strictEqual(h.commands.length, 5);
      const told = h.deliveries.map((each) => [each.key, each.to, each.from]);
      assert.deepStrictEqual(told, [
        [
          "schedule-command-failed:mail:2026-11-10T08:15:00.000Z",
          "mail",
          "Pult, about schedule mail",
        ],
        [
          "schedule-command-failed:mail:2026-11-10T09:00:00.000Z",
          "mail",
          "Pult, about schedule mail",
        ],
      ]);
      assert.strictEqual(
        h.deliveries[0]?.text,
        "`.pult/schedules/mail.md`'s command failed: exited 2\nno such mailbox. Pult tells you again only after it has run cleanly.",
      );
      assert.deepStrictEqual(yield* h.records("mail"), [
        "2026-11-10T08-15Z.yaml",
        "2026-11-10T08-30Z.yaml",
        "2026-11-10T09-00Z.yaml",
        "2026-11-10T09-15Z.yaml",
      ]);
      const [mail] = yield* h.view;
      assert.deepStrictEqual(mail?.last, {
        due: "2026-11-10T09:15:00.000Z",
        fired: "2026-11-10T09:15:01.000Z",
        result: "failed",
        error: "exited 2\nno such mailbox",
        thread: null,
      });
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
