import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import { Effect, FileSystem, Layer, Path } from "../host.ts";
import { AGENTS_TEXT, AGENTS_VERSION } from "./agents.ts";
import { recordText } from "./record.ts";
import * as Stars from "./stars.ts";
import { at, fakeServer, run } from "./testing.ts";

/** The Stars over a fake server; `runPass` runs the pass a minute after the last, as the scheduler's tick would. */
const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* fakeServer;
  const stars = yield* Stars.make.pipe(Effect.provide(server.layer));
  const write = (file: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    });
  const read = (file: string) => fs.readFileString(file);
  const runPass = Effect.andThen(TestClock.adjust("1 minute"), server.runPass);
  return { ...server, stars, fs, path, write, read, runPass };
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const record = (id: string, name = "") =>
  recordText({ id, name, tint: "amber", created: "2026-11-10T12:00:00.000Z" });

describe("starsDirectory", () => {
  it.effect(
    "is beside the server's home, or under its state for a dev run on the default home",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const directory = (baseDir: string, state: string) =>
          Stars.starsDirectory({ baseDir, stateDir: path.join(baseDir, state) }, path);
        assert.strictEqual(directory("/Users/a/.t3", "userdata"), "/Users/a/.pult/stars");
        assert.strictEqual(
          directory("/repos/pult/wt/.t3", "userdata"),
          "/repos/pult/wt/.pult/stars",
        );
        assert.strictEqual(directory("/Users/a/.t3", "dev"), "/Users/a/.t3/dev/.pult/stars");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("finding", () => {
  it.effect("is a project rooted in a folder of the directory that holds a record", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const root = h.path.join(h.directory, "vega");
      yield* h.write(h.path.join(root, ".pult/star.yaml"), record("vega-id", "Vega"));
      yield* h.projects.service.create({
        projectId: ProjectId.make("p-vega"),
        title: "Vega",
        workspaceRoot: root,
      });
      // Elsewhere, or without a record: no Star.
      const elsewhere = h.path.join(h.tmp, "repos", "star");
      yield* h.write(h.path.join(elsewhere, ".pult/star.yaml"), record("other-id"));
      yield* h.projects.service.create({
        projectId: ProjectId.make("p-else"),
        title: "x",
        workspaceRoot: elsewhere,
      });
      const plain = h.path.join(h.directory, "plain");
      yield* h.fs.makeDirectory(plain, { recursive: true });
      yield* h.projects.service.create({
        projectId: ProjectId.make("p-plain"),
        title: "x",
        workspaceRoot: plain,
      });

      const stars = yield* h.stars.list;
      assert.deepStrictEqual(stars, [
        {
          id: "vega-id",
          name: "Vega",
          tint: "amber",
          created: "2026-11-10T12:00:00.000Z",
          root,
          projectId: ProjectId.make("p-vega"),
        },
      ]);
      assert.strictEqual((yield* h.stars.get("vega-id"))?.root, root);
      assert.strictEqual(yield* h.stars.get("Vega"), undefined);
    }).pipe(Effect.scoped),
  );

  it.effect("finds no Star in two folders carrying one id, nor in a layout before star.yaml", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      for (const folder of ["a", "b"]) {
        const root = h.path.join(h.directory, folder);
        yield* h.write(h.path.join(root, ".pult/star.yaml"), record("twin"));
        yield* h.projects.service.create({
          projectId: ProjectId.make(`p-${folder}`),
          title: "Star",
          workspaceRoot: root,
        });
      }
      const legacy = h.path.join(h.directory, "legacy");
      yield* h.write(
        h.path.join(legacy, "AGENTS.md"),
        `---\n${record("legacy-id")}---\n\n# Star\n`,
      );
      yield* h.projects.service.create({
        projectId: ProjectId.make("p-legacy"),
        title: "Star",
        workspaceRoot: legacy,
      });
      assert.deepStrictEqual(yield* h.stars.list, []);
      // Every project in a `.pult/stars` folder is still hidden from a page.
      assert.sameMembers([...(yield* h.stars.view).hidden], ["p-a", "p-b", "p-legacy"]);
    }).pipe(Effect.scoped),
  );
});

describe("creation", () => {
  it.effect(
    "makes a Star in a fresh folder each time, and under ifNone answers the one there",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const first = yield* h.stars.create({ ifNone: true });
        assert.strictEqual(first.root, h.path.join(h.directory, "star"));
        assert.strictEqual(first.name, "");
        assert.strictEqual(yield* h.read(h.path.join(first.root, "AGENTS.md")), AGENTS_TEXT);
        assert.strictEqual(yield* h.read(h.path.join(first.root, "instructions.md")), "");
        assert.isTrue(yield* h.fs.exists(h.path.join(first.root, ".pult/conversations")));
        assert.deepStrictEqual(h.projects.shells[0], {
          ...h.projects.shells[0]!,
          title: "Star",
          projectIcon: { kind: "emoji", emoji: "🌟" },
        });

        assert.strictEqual((yield* h.stars.create({ ifNone: true })).id, first.id);
        const second = yield* h.stars.create({ ifNone: false });
        assert.strictEqual(second.root, h.path.join(h.directory, "star-2"));
        assert.notStrictEqual(second.id, first.id);
        assert.sameMembers(
          (yield* h.stars.list).map((star) => star.id),
          [first.id, second.id],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("never creates over anything at a folder's path", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.write(h.path.join(h.directory, "star", "notes.md"), "mine");
      const star = yield* h.stars.create({ ifNone: true });
      assert.strictEqual(star.root, h.path.join(h.directory, "star-2"));
      assert.strictEqual(yield* h.read(h.path.join(h.directory, "star", "notes.md")), "mine");
    }).pipe(Effect.scoped),
  );
});

describe("upkeep", () => {
  it.effect(
    "adopts a folder with a record, keeps AGENTS.md and the title up, and does it once",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const arrived = h.path.join(h.directory, "arrived");
        yield* h.write(h.path.join(arrived, ".pult/star.yaml"), record("arrived-id", "Vega"));
        const older = h.path.join(h.directory, "older");
        yield* h.write(h.path.join(older, ".pult/star.yaml"), record("older-id"));
        yield* h.write(
          h.path.join(older, "AGENTS.md"),
          `<!-- pult-agents-md: ${AGENTS_VERSION - 1} -->\n`,
        );
        yield* h.projects.service.create({
          projectId: ProjectId.make("p-older"),
          title: "Old name",
          workspaceRoot: older,
        });
        const newer = h.path.join(h.directory, "newer");
        const newerText = `<!-- pult-agents-md: ${AGENTS_VERSION + 1} -->\n`;
        yield* h.write(h.path.join(newer, ".pult/star.yaml"), record("newer-id", "Sirius"));
        yield* h.write(h.path.join(newer, "AGENTS.md"), newerText);
        yield* h.projects.service.create({
          projectId: ProjectId.make("p-newer"),
          title: "Sirius",
          workspaceRoot: newer,
        });

        yield* h.stars.upkeep;
        yield* h.stars.upkeep;

        const adopted = h.projects.shells.filter((shell) => shell.workspaceRoot === arrived);
        assert.strictEqual(adopted.length, 1);
        assert.strictEqual(adopted[0]?.title, "Vega");
        assert.deepStrictEqual(adopted[0]?.projectIcon, { kind: "emoji", emoji: "🌟" });
        assert.strictEqual(yield* h.read(h.path.join(arrived, "AGENTS.md")), AGENTS_TEXT);
        assert.strictEqual(yield* h.read(h.path.join(older, "AGENTS.md")), AGENTS_TEXT);
        assert.strictEqual(yield* h.read(h.path.join(newer, "AGENTS.md")), newerText);
        assert.strictEqual(
          h.projects.shells.find((shell) => shell.id === "p-older")?.title,
          "Star",
        );
        assert.strictEqual(h.projects.shells.length, 3);
      }).pipe(Effect.scoped),
  );

  it.effect("rewrites a record's name and tint, keeping its other lines, and retitles", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const star = yield* h.stars.create({ ifNone: true });
      const file = h.path.join(star.root, ".pult/star.yaml");
      yield* h.write(file, `${yield* h.read(file)}# the Star's own line\n`);
      const renamed = yield* h.stars.setRecord(star, { name: "Vega", tint: "sky" });
      assert.deepStrictEqual(renamed, { ...star, name: "Vega", tint: "sky" });
      assert.match(
        yield* h.read(file),
        /^name: "Vega"\ntint: "sky"\ncreated: .*\n# the Star's own line\n$/m,
      );
      assert.strictEqual(h.projects.shells[0]?.title, "Vega");

      // A record that names another Star by now fails, and is left as it was.
      const other = record("other-id", "Other");
      yield* h.write(file, other);
      const refused = yield* Effect.flip(h.stars.setRecord(star, { name: "Lyra" }));
      assert.deepStrictEqual([refused._tag, refused.operation], ["StarsError", "write-record"]);
      assert.strictEqual(yield* h.read(file), other);
    }).pipe(Effect.scoped),
  );
});

describe("the pass", () => {
  it.effect(
    "settles a due conversation, leaves a held one, and keeps the transcripts of the settled",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
        const h = yield* harness;
        const star = yield* h.stars.create({ ifNone: true });
        const folder = h.path.join(star.root, ".pult/conversations/env-1");
        // Expired an hour ago, its one run finished.
        const due = h.threads.add(
          star.projectId,
          "due",
          {
            createdAt: at("2026-11-10T11:00:00.000Z"),
            promptCacheExpiresAt: at("2026-11-10T12:00:00.000Z"),
          },
          [run("due-run", "completed")],
        );
        const held = h.threads.add(
          star.projectId,
          "held",
          {
            createdAt: at("2026-11-10T12:30:00.000Z"),
            promptCacheExpiresAt: at("2026-11-10T12:00:00.000Z"),
          },
          [run("held-run", "running")],
        );
        // Settled, its transcript missing.
        h.threads.add(star.projectId, "ended", {
          createdAt: at("2026-11-10T09:00:00.000Z"),
          settledOverride: "settled",
          settledAt: at("2026-11-10T10:00:00.000Z"),
        });

        yield* h.runPass;
        assert.deepStrictEqual(h.threads.settles, [due.shell.id]);
        assert.strictEqual(held.shell.settledOverride, null);
        const names = (yield* h.fs.readDirectory(folder)).toSorted();
        assert.deepStrictEqual(names, [
          "2026-11-10T09-00-00Z-ended.md",
          "2026-11-10T11-00-00Z-due.md",
        ]);
        const dueFile = h.path.join(folder, "2026-11-10T11-00-00Z-due.md");
        assert.match(yield* h.read(dueFile), /^ended: "2026-11-10T13:01:00.000Z"$/m);
        assert.match(yield* h.read(dueFile), /^environment: "MacBook"$/m);

        // Written ones are left; one settled again is rewritten.
        const endedFile = h.path.join(folder, "2026-11-10T09-00-00Z-ended.md");
        yield* h.write(endedFile, `${yield* h.read(endedFile)}\nthe Star's note\n`);
        due.shell = { ...due.shell, settledAt: at("2026-11-10T13:01:30.000Z") };
        yield* h.runPass;
        assert.match(yield* h.read(endedFile), /the Star's note/);
        assert.match(yield* h.read(dueFile), /^ended: "2026-11-10T13:01:30.000Z"$/m);
        assert.deepStrictEqual(h.threads.settles, [due.shell.id]);

        const [view] = (yield* h.stars.view).stars;
        assert.deepStrictEqual(view?.conversation, {
          threadId: held.shell.id,
          sleeps: { heldBy: "run" },
        });
        assert.strictEqual(view?.asleepSince, "2026-11-10T13:01:30.000Z");
        assert.deepStrictEqual(view?.conversations, names);
        assert.deepStrictEqual((yield* h.stars.transcript(star, names[0]!))?.threadId, "ended");
        assert.strictEqual(yield* h.stars.transcript(star, "../../../etc/passwd"), undefined);
      }).pipe(Effect.scoped),
  );

  it.effect("hands a use the current conversation and the last, once it has looked", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
      const h = yield* harness;
      const star = yield* h.stars.create({ ifNone: true });
      h.threads.add(star.projectId, "older", {
        createdAt: at("2026-11-10T08:00:00.000Z"),
        settledOverride: "settled",
        settledAt: at("2026-11-10T09:00:00.000Z"),
      });
      h.threads.add(star.projectId, "due", {
        createdAt: at("2026-11-10T11:00:00.000Z"),
        promptCacheExpiresAt: at("2026-11-10T12:00:00.000Z"),
      });
      const open = h.threads.add(star.projectId, "open", {
        createdAt: at("2026-11-10T12:50:00.000Z"),
        promptCacheExpiresAt: at("2026-11-10T13:20:00.000Z"),
      });
      h.threads.add(star.projectId, "fork", {
        createdAt: at("2026-11-10T12:55:00.000Z"),
        lineage: {
          parentThreadId: open.shell.id,
          relationshipToParent: "fork",
          rootThreadId: open.shell.id,
        },
      });

      const seen = yield* h.stars.withConversation(star, ({ current, last }) =>
        Effect.succeed([String(current?.id), String(last?.id)]),
      );
      assert.deepStrictEqual(seen, ["open", "due"]);
      assert.strictEqual((yield* h.stars.ofThread(open.shell.id))?.id, star.id);
      assert.strictEqual(yield* h.stars.ofThread(ThreadId.make("fork")), undefined);
    }).pipe(Effect.scoped),
  );
});

describe("a Star's request to sleep", () => {
  const later = at("2026-11-10T13:30:00.000Z");

  it.effect(
    "settles the conversation before its deadline and writes the transcript in one look",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
        const h = yield* harness;
        const star = yield* h.stars.create({ ifNone: true });
        const asks = h.threads.add(
          star.projectId,
          "asks",
          { createdAt: at("2026-11-10T12:50:00.000Z"), promptCacheExpiresAt: later },
          [run("asks-run", "completed")],
        );
        const other = h.threads.add(
          star.projectId,
          "other",
          { createdAt: at("2026-11-10T12:40:00.000Z"), promptCacheExpiresAt: later },
          [run("other-run", "completed")],
        );

        yield* h.stars.sleepNow(star, asks.shell.id, RunId.make("asks-run"));
        assert.deepStrictEqual(h.threads.settles, [asks.shell.id]);
        assert.strictEqual(other.shell.settledOverride, null);
        assert.match(
          yield* h.read(
            h.path.join(star.root, ".pult/conversations/env-1/2026-11-10T12-50-00Z-asks.md"),
          ),
          /^ended: "2026-11-10T13:00:00.000Z"$/m,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("leaves it awake where a run followed the turn or a thread below works", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
      const h = yield* harness;
      const star = yield* h.stars.create({ ifNone: true });
      const conversation = (id: string, runs: ReadonlyArray<OrchestrationV2Run>) =>
        h.threads.add(star.projectId, id, { promptCacheExpiresAt: later }, [...runs]);
      const turn = (id: string) => ({ ...run(id, "completed"), ordinal: 1 });
      // A user's message queued behind the turn; a notification that already ran after it.
      const queued = conversation("queued", [
        turn("queued-1"),
        { ...run("queued-2", "queued"), ordinal: 2 },
      ]);
      const followed = conversation("followed", [
        turn("followed-1"),
        { ...run("followed-2", "completed"), ordinal: 2 },
      ]);
      const delegating = conversation("delegating", [turn("delegating-1")]);
      delegating.subagents = [{ status: "running" } as OrchestrationV2Subagent];

      for (const [thread, runId] of [
        [queued, "queued-1"],
        [followed, "followed-1"],
        [delegating, "delegating-1"],
      ] as const)
        yield* h.stars.sleepNow(star, thread.shell.id, RunId.make(runId));
      assert.deepStrictEqual(h.threads.settles, []);

      delegating.subagents = [{ status: "completed" } as OrchestrationV2Subagent];
      yield* h.stars.sleepNow(star, delegating.shell.id, RunId.make("delegating-1"));
      assert.deepStrictEqual(h.threads.settles, [delegating.shell.id]);
    }).pipe(Effect.scoped),
  );
});

describe("asks", () => {
  it.effect(
    "are the .md files of .pult/asks by name, an empty one and an unreadable one titled by it",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const star = yield* h.stars.create({ ifNone: true });
        assert.deepStrictEqual((yield* h.stars.view).stars[0]?.asks, []);

        const folder = h.path.join(star.root, ".pult/asks");
        yield* h.write(h.path.join(folder, "rust-backend.md"), "# Rust backend\n\nWhich crate?\n");
        yield* h.write(h.path.join(folder, "empty.md"), "");
        yield* h.write(h.path.join(folder, "notes.txt"), "no ask");
        // A link to nowhere: listed, and failing to read.
        yield* h.fs.symlink(h.path.join(h.tmp, "nowhere.md"), h.path.join(folder, "lost.md"));

        const askAt = (name: string) => h.path.join(folder, `${name}.md`);
        assert.deepStrictEqual((yield* h.stars.view).stars[0]?.asks, [
          { name: "empty", title: "empty", text: "", path: askAt("empty") },
          { name: "lost", title: "lost", text: "", path: askAt("lost") },
          {
            name: "rust-backend",
            title: "Rust backend",
            text: "# Rust backend\n\nWhich crate?\n",
            path: askAt("rust-backend"),
          },
        ]);
      }).pipe(Effect.scoped),
  );
});
