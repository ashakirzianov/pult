// Run with `node --test src/stars/stars.test.ts`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { newRecord } from "./record.ts";
import {
  asleepSince,
  creationTarget,
  earlierConversations,
  type EnvironmentReading,
  foldersToAdopt,
  findStarOfThread,
  starsOf,
  wakeHome,
} from "./stars.ts";

const record = (id: string) => newRecord(id, "2026-11-01T00:00:00.000Z");
const folder = (
  environmentId: string,
  id: string,
  root = "/home/a/.pult/stars/star",
  transcripts: ReadonlyArray<string> = [],
) => ({
  environmentId,
  root,
  record: record(id),
  transcripts,
});
const names = (count: number) =>
  Array.from({ length: count }, (_, index) => `2026-11-0${index + 1}T10-00-00Z-t${index}.md`);
const project = (
  environmentId: string,
  id: string,
  root: string | null = "/home/a/.pult/stars/star",
) => ({ environmentId, id, root });
const thread = (
  environmentId: string,
  id: string,
  createdAt: string,
  overrides: Partial<{
    projectId: string;
    parentId: string | null;
    settled: boolean;
    settledAt: string | null;
    working: boolean;
  }> = {},
) => ({
  environmentId,
  id,
  projectId: "star-project",
  parentId: null,
  settled: false,
  settledAt: null,
  createdAt,
  working: false,
  workingSince: null,
  ageFrom: createdAt,
  ...overrides,
});

describe("starsOf", () => {
  test("merges the folders that carry one id into one Star with a home on each environment", () => {
    const stars = starsOf(
      [
        folder("a", "one"),
        folder("b", "one", "/Users/b/.pult/stars/star/"),
        folder("b", "two", "/Users/b/.pult/stars/other"),
      ],
      [project("a", "star-project"), project("b", "p", "/Users/b/.pult/stars/star")],
      [],
    );
    assert.deepEqual(
      stars.map((star) => star.id),
      ["one", "two"],
    );
    assert.deepEqual(
      stars[0]?.homes.map((home) => [home.environmentId, home.projectId]),
      [
        ["a", "star-project"],
        ["b", "p"],
      ],
    );
    assert.equal(stars[1]?.homes[0]?.projectId, null);
  });

  test("takes the newest open root thread across the homes as the current conversation", () => {
    const threads = [
      thread("a", "old", "2026-11-01T00:00:00.000Z"),
      thread("b", "newest-settled", "2026-11-03T00:00:00.000Z", { settled: true }),
      thread("b", "open", "2026-11-02T00:00:00.000Z"),
      thread("b", "subagent", "2026-11-04T00:00:00.000Z", { parentId: "open" }),
      thread("a", "elsewhere", "2026-11-05T00:00:00.000Z", { projectId: "other" }),
    ];
    const [star] = starsOf(
      [folder("a", "one"), folder("b", "one")],
      [project("a", "star-project"), project("b", "star-project")],
      threads,
    );
    assert.equal(star?.current?.id, "open");
    assert.equal(star?.latest?.id, "newest-settled");
    assert.equal(star?.state, "awake");
  });

  test("is asleep with no open root thread, and working while its current conversation's run is on", () => {
    const projects = [project("a", "star-project")];
    assert.equal(
      starsOf([folder("a", "one")], projects, [
        thread("a", "t", "2026-11-01T00:00:00.000Z", { settled: true }),
      ])[0]?.state,
      "asleep",
    );
    assert.equal(
      starsOf([folder("a", "one")], projects, [
        thread("a", "t", "2026-11-01T00:00:00.000Z", { working: true }),
      ])[0]?.state,
      "working",
    );
  });

  test("has slept since its last conversation's end, else its newest transcript's end or else start, else its creation", () => {
    const projects = [project("a", "star-project")];
    const threads = [
      thread("a", "older-ended-later", "2026-11-01T00:00:00.000Z", {
        settled: true,
        settledAt: "2026-11-03T09:00:00.000Z",
      }),
      thread("a", "newer", "2026-11-02T00:00:00.000Z", {
        settled: true,
        settledAt: "2026-11-02T09:00:00.000Z",
      }),
    ];
    const [ended] = starsOf([folder("a", "one", undefined, names(2))], projects, threads);
    assert.equal(ended && asleepSince(ended), "2026-11-03T09:00:00.000Z");
    const [transcribed] = starsOf(
      [{ ...folder("a", "one", undefined, names(2)), newestEnded: "2026-11-02T11:30:00.000Z" }],
      projects,
      [],
    );
    assert.equal(transcribed && asleepSince(transcribed), "2026-11-02T11:30:00.000Z");
    const [listed] = starsOf([folder("a", "one", undefined, names(2))], projects, []);
    assert.equal(listed && asleepSince(listed), "2026-11-02T10:00:00.000Z");
    const [fresh] = starsOf([folder("a", "one")], projects, []);
    assert.equal(fresh && asleepSince(fresh), "2026-11-01T00:00:00.000Z");
  });
});

describe("a Star's places", () => {
  const projects = [project("a", "star-project"), project("b", "star-project")];
  const threads = [thread("b", "last", "2026-11-02T00:00:00.000Z", { settled: true })];
  const [star] = starsOf(
    [folder("a", "one", undefined, names(3)), folder("b", "one", undefined, names(5))],
    projects,
    threads,
  );

  test("wakes in its latest conversation's home, else its first held one", () => {
    assert.equal(star && wakeHome(star, () => true)?.environmentId, "b");
    assert.equal(
      star && wakeHome(star, (environmentId) => environmentId === "a")?.environmentId,
      "a",
    );
    assert.equal(star && wakeHome(star, () => false), undefined);
  });

  test("counts the earlier conversations of the environment that ran last", () => {
    assert.equal(star && earlierConversations(star), 5);
    assert.equal(
      earlierConversations({ homes: star?.homes ?? [], current: null, latest: null }),
      0,
    );
  });

  test("owns the root threads of its homes' projects, not their subagents", () => {
    assert.equal(
      findStarOfThread(star ? [star] : [], {
        environmentId: "b",
        projectId: "star-project",
        parentId: null,
      })?.id,
      "one",
    );
    assert.equal(
      findStarOfThread(star ? [star] : [], {
        environmentId: "b",
        projectId: "star-project",
        parentId: "last",
      }),
      undefined,
    );
  });
});

describe("foldersToAdopt", () => {
  test("adopts a folder with no project, once its environment's projects are in", () => {
    const folders = [folder("a", "one"), folder("b", "two"), folder("c", "three")];
    const adopted = foldersToAdopt(
      folders,
      [project("a", "p")],
      (environmentId) => environmentId !== "c",
    );
    assert.deepEqual(
      adopted.map((each) => each.environmentId),
      ["b"],
    );
  });
});

describe("creationTarget", () => {
  const reading = (
    id: string,
    overrides: Partial<EnvironmentReading> = {},
  ): EnvironmentReading => ({
    id,
    phase: "ready",
    loaded: true,
    read: "read",
    attempted: false,
    ...overrides,
  });

  const decide = (
    environments: EnvironmentReading[],
    overrides: Partial<{
      enabled: boolean;
      restoring: boolean;
      halted: boolean;
      stars: number;
    }> = {},
  ) =>
    creationTarget({
      enabled: true,
      restoring: false,
      halted: false,
      stars: 0,
      environments,
      ...overrides,
    });

  test("creates on the first ready environment once every one has answered", () => {
    assert.equal(
      decide([reading("a", { phase: "offline", read: "failed" }), reading("b"), reading("c")]),
      "b",
    );
    assert.equal(decide([reading("a", { attempted: true }), reading("b")]), "b");
  });

  test("waits while an environment is still connecting, reading or loading its projects, or the page restores", () => {
    assert.equal(
      decide([reading("a"), reading("b", { phase: "connecting", read: "pending" })]),
      undefined,
    );
    assert.equal(decide([reading("a"), reading("b", { read: "pending" })]), undefined);
    assert.equal(decide([reading("a"), reading("b", { loaded: false })]), undefined);
    assert.equal(decide([reading("a")], { restoring: true }), undefined);
  });

  test("creates nothing while a Star is held, Show Star is off, or every environment was tried", () => {
    assert.equal(decide([reading("a")], { stars: 1 }), undefined);
    assert.equal(decide([reading("a")], { enabled: false }), undefined);
    assert.equal(decide([reading("a", { attempted: true })]), undefined);
  });

  test("creates nothing while a ready environment's folder failed to read, since it may hold the Star", () => {
    assert.equal(decide([reading("a", { read: "failed" }), reading("b")]), undefined);
    assert.equal(decide([reading("a"), reading("b", { read: "failed" })]), undefined);
  });

  test("creates nothing on another environment after a creation failed, was refused or lost a race", () => {
    assert.equal(
      decide([reading("a", { attempted: true }), reading("b")], { halted: true }),
      undefined,
    );
  });
});
