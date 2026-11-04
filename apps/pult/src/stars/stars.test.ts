// Run with `node --test src/stars/stars.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

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

NodeTest.describe("starsOf", () => {
  NodeTest.test(
    "merges the folders that carry one id into one Star with a home on each environment",
    () => {
      const stars = starsOf(
        [
          folder("a", "one"),
          folder("b", "one", "/Users/b/.pult/stars/star/"),
          folder("b", "two", "/Users/b/.pult/stars/other"),
        ],
        [project("a", "star-project"), project("b", "p", "/Users/b/.pult/stars/star")],
        [],
      );
      NodeAssert.deepEqual(
        stars.map((star) => star.id),
        ["one", "two"],
      );
      NodeAssert.deepEqual(
        stars[0]?.homes.map((home) => [home.environmentId, home.projectId]),
        [
          ["a", "star-project"],
          ["b", "p"],
        ],
      );
      NodeAssert.equal(stars[1]?.homes[0]?.projectId, null);
    },
  );

  NodeTest.test(
    "takes the newest open root thread across the homes as the current conversation",
    () => {
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
      NodeAssert.equal(star?.current?.id, "open");
      NodeAssert.equal(star?.latest?.id, "newest-settled");
      NodeAssert.equal(star?.state, "awake");
    },
  );

  NodeTest.test(
    "is asleep with no open root thread, and working while its current conversation's run is on",
    () => {
      const projects = [project("a", "star-project")];
      NodeAssert.equal(
        starsOf([folder("a", "one")], projects, [
          thread("a", "t", "2026-11-01T00:00:00.000Z", { settled: true }),
        ])[0]?.state,
        "asleep",
      );
      NodeAssert.equal(
        starsOf([folder("a", "one")], projects, [
          thread("a", "t", "2026-11-01T00:00:00.000Z", { working: true }),
        ])[0]?.state,
        "working",
      );
    },
  );

  NodeTest.test(
    "has slept since its last conversation's end, else its newest transcript's end or else start, else its creation",
    () => {
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
      NodeAssert.equal(ended && asleepSince(ended), "2026-11-03T09:00:00.000Z");
      const [transcribed] = starsOf(
        [{ ...folder("a", "one", undefined, names(2)), newestEnded: "2026-11-02T11:30:00.000Z" }],
        projects,
        [],
      );
      NodeAssert.equal(transcribed && asleepSince(transcribed), "2026-11-02T11:30:00.000Z");
      const [listed] = starsOf([folder("a", "one", undefined, names(2))], projects, []);
      NodeAssert.equal(listed && asleepSince(listed), "2026-11-02T10:00:00.000Z");
      const [fresh] = starsOf([folder("a", "one")], projects, []);
      NodeAssert.equal(fresh && asleepSince(fresh), "2026-11-01T00:00:00.000Z");
    },
  );
});

NodeTest.describe("a Star's places", () => {
  const projects = [project("a", "star-project"), project("b", "star-project")];
  const threads = [thread("b", "last", "2026-11-02T00:00:00.000Z", { settled: true })];
  const [star] = starsOf(
    [folder("a", "one", undefined, names(3)), folder("b", "one", undefined, names(5))],
    projects,
    threads,
  );

  NodeTest.test("wakes in its latest conversation's home, else its first held one", () => {
    NodeAssert.equal(star && wakeHome(star, () => true)?.environmentId, "b");
    NodeAssert.equal(
      star && wakeHome(star, (environmentId) => environmentId === "a")?.environmentId,
      "a",
    );
    NodeAssert.equal(star && wakeHome(star, () => false), undefined);
  });

  NodeTest.test("counts the earlier conversations of the environment that ran last", () => {
    NodeAssert.equal(star && earlierConversations(star), 5);
    NodeAssert.equal(
      earlierConversations({ homes: star?.homes ?? [], current: null, latest: null }),
      0,
    );
  });

  NodeTest.test("owns the root threads of its homes' projects, not their subagents", () => {
    NodeAssert.equal(
      findStarOfThread(star ? [star] : [], {
        environmentId: "b",
        projectId: "star-project",
        parentId: null,
      })?.id,
      "one",
    );
    NodeAssert.equal(
      findStarOfThread(star ? [star] : [], {
        environmentId: "b",
        projectId: "star-project",
        parentId: "last",
      }),
      undefined,
    );
  });
});

NodeTest.describe("foldersToAdopt", () => {
  NodeTest.test("adopts a folder with no project, once its environment's projects are in", () => {
    const folders = [folder("a", "one"), folder("b", "two"), folder("c", "three")];
    const adopted = foldersToAdopt(
      folders,
      [project("a", "p")],
      (environmentId) => environmentId !== "c",
    );
    NodeAssert.deepEqual(
      adopted.map((each) => each.environmentId),
      ["b"],
    );
  });
});

NodeTest.describe("creationTarget", () => {
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

  NodeTest.test("creates on the first ready environment once every one has answered", () => {
    NodeAssert.equal(
      decide([reading("a", { phase: "offline", read: "failed" }), reading("b"), reading("c")]),
      "b",
    );
    NodeAssert.equal(decide([reading("a", { attempted: true }), reading("b")]), "b");
  });

  NodeTest.test(
    "waits while an environment is still connecting, reading or loading its projects, or the page restores",
    () => {
      NodeAssert.equal(
        decide([reading("a"), reading("b", { phase: "connecting", read: "pending" })]),
        undefined,
      );
      NodeAssert.equal(decide([reading("a"), reading("b", { read: "pending" })]), undefined);
      NodeAssert.equal(decide([reading("a"), reading("b", { loaded: false })]), undefined);
      NodeAssert.equal(decide([reading("a")], { restoring: true }), undefined);
    },
  );

  NodeTest.test(
    "creates nothing while a Star is held, Show Star is off, or every environment was tried",
    () => {
      NodeAssert.equal(decide([reading("a")], { stars: 1 }), undefined);
      NodeAssert.equal(decide([reading("a")], { enabled: false }), undefined);
      NodeAssert.equal(decide([reading("a", { attempted: true })]), undefined);
    },
  );

  NodeTest.test(
    "creates nothing while a ready environment's folder failed to read, since it may hold the Star",
    () => {
      NodeAssert.equal(decide([reading("a", { read: "failed" }), reading("b")]), undefined);
      NodeAssert.equal(decide([reading("a"), reading("b", { read: "failed" })]), undefined);
    },
  );

  NodeTest.test(
    "creates nothing on another environment after a creation failed, was refused or lost a race",
    () => {
      NodeAssert.equal(
        decide([reading("a", { attempted: true }), reading("b")], { halted: true }),
        undefined,
      );
    },
  );
});
