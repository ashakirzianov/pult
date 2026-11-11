// Run with `node --test src/stars/stars.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { RouteStar, StarsAnswer } from "./plugin.ts";
import {
  creationTarget,
  drawnHome,
  type EnvironmentReading,
  findStarOfThread,
  newTranscripts,
  starsOf,
  wakeHome,
} from "./stars.ts";

const CREATED = "2026-11-01T00:00:00.000Z";

const routeStar = (id: string, overrides: Partial<RouteStar> = {}): RouteStar => ({
  id,
  name: "",
  tint: "amber",
  created: CREATED,
  root: `/Users/a/.pult/stars/${id}`,
  projectId: "star-project",
  instructions: `/Users/a/.pult/stars/${id}/instructions.md`,
  conversation: null,
  asleepSince: CREATED,
  conversations: [],
  schedules: [],
  ...overrides,
});
const answer = (stars: ReadonlyArray<RouteStar>, hidden: ReadonlyArray<string> = []) =>
  ({ directory: "/Users/a/.pult/stars", hidden, stars }) satisfies StarsAnswer;
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
const current = (threadId: string) => ({ threadId, sleeps: { at: "2026-11-05T00:00:00.000Z" } });

NodeTest.describe("starsOf", () => {
  NodeTest.test(
    "merges one id on several environments into one Star with a home on each, named by its first",
    () => {
      const stars = starsOf(
        [
          {
            environmentId: "a",
            answer: answer([routeStar("one", { name: "Vega" })]),
            origin: "git@x:s",
          },
          {
            environmentId: "b",
            answer: answer([routeStar("one", { name: "Other", projectId: "p" }), routeStar("two")]),
          },
        ],
        [],
      );
      NodeAssert.deepEqual(
        stars.map((star) => [star.id, star.name]),
        [
          ["one", "Vega"],
          ["two", ""],
        ],
      );
      NodeAssert.deepEqual(
        stars[0]?.homes.map((home) => [home.environmentId, home.projectId, home.origin]),
        [
          ["a", "star-project", "git@x:s"],
          ["b", "p", undefined],
        ],
      );
      NodeAssert.equal(stars[0]?.origin, "git@x:s");
    },
  );

  NodeTest.test("takes the live row of the conversation a home's plugin names as current", () => {
    const threads = [
      thread("a", "older", "2026-11-01T00:00:00.000Z"),
      thread("b", "newer", "2026-11-02T00:00:00.000Z", { working: true }),
      thread("b", "unnamed", "2026-11-03T00:00:00.000Z"),
    ];
    const [star] = starsOf(
      [
        {
          environmentId: "a",
          answer: answer([routeStar("one", { conversation: current("older") })]),
        },
        {
          environmentId: "b",
          answer: answer([routeStar("one", { conversation: current("newer") })]),
        },
      ],
      threads,
    );
    NodeAssert.equal(star?.current?.id, "newer");
    NodeAssert.equal(star?.state, "working");
  });

  NodeTest.test(
    "is asleep where the plugin names no conversation, or the page has seen it settle or holds no row of it",
    () => {
      const asleep = (
        conversation: RouteStar["conversation"],
        threads: ReturnType<typeof thread>[],
      ) =>
        starsOf(
          [{ environmentId: "a", answer: answer([routeStar("one", { conversation })]) }],
          threads,
        )[0];
      NodeAssert.equal(asleep(null, [thread("a", "t", CREATED)])?.state, "asleep");
      NodeAssert.equal(
        asleep(current("t"), [thread("a", "t", CREATED, { settled: true })])?.current,
        null,
      );
      NodeAssert.equal(asleep(current("t"), [])?.state, "asleep");
      NodeAssert.equal(asleep(current("t"), [thread("a", "t", CREATED)])?.state, "awake");
    },
  );

  NodeTest.test("has slept since the latest of its homes' sleeps", () => {
    const [star] = starsOf(
      [
        {
          environmentId: "a",
          answer: answer([routeStar("one", { asleepSince: "2026-11-03T09:00:00.000Z" })]),
        },
        {
          environmentId: "b",
          answer: answer([routeStar("one", { asleepSince: "2026-11-02T09:00:00.000Z" })]),
        },
      ],
      [],
    );
    NodeAssert.equal(star?.asleepSince, "2026-11-03T09:00:00.000Z");
  });
});

NodeTest.describe("a Star's places", () => {
  const [star] = starsOf(
    [
      {
        environmentId: "a",
        answer: answer([
          routeStar("one", { asleepSince: "2026-11-02T00:00:00.000Z", conversations: ["x.md"] }),
        ]),
      },
      {
        environmentId: "b",
        answer: answer([
          routeStar("one", {
            asleepSince: "2026-11-03T00:00:00.000Z",
            conversations: ["y.md", "z.md"],
          }),
        ]),
      },
    ],
    [],
  );

  NodeTest.test(
    "is drawn from its current conversation's home, else the one that slept last",
    () => {
      NodeAssert.equal(star && drawnHome(star)?.environmentId, "b");
      NodeAssert.deepEqual(star && drawnHome(star)?.conversations, ["y.md", "z.md"]);
      const awake = star && { ...star, current: thread("a", "t", CREATED) };
      NodeAssert.equal(awake && drawnHome(awake)?.environmentId, "a");
    },
  );

  NodeTest.test("wakes in the home it is drawn from, else its first held one", () => {
    NodeAssert.equal(star && wakeHome(star, () => true)?.environmentId, "b");
    NodeAssert.equal(
      star && wakeHome(star, (environmentId) => environmentId === "a")?.environmentId,
      "a",
    );
    NodeAssert.equal(star && wakeHome(star, () => false), undefined);
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

NodeTest.describe("newTranscripts", () => {
  NodeTest.test("names the transcripts a Star's answer gained since the earlier one", () => {
    const earlier = answer([routeStar("one", { conversations: ["a.md"] }), routeStar("two")]);
    const next = answer([
      routeStar("one", { conversations: ["a.md", "b.md", "c.md"] }),
      routeStar("two"),
      routeStar("three", { conversations: ["d.md"] }),
    ]);
    NodeAssert.deepEqual(newTranscripts(earlier, next), [
      { starId: "one", names: ["b.md", "c.md"] },
    ]);
  });

  NodeTest.test("names none on the first answer, which the sync on connect commits", () => {
    NodeAssert.deepEqual(
      newTranscripts(undefined, answer([routeStar("one", { conversations: ["a.md"] })])),
      [],
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
    NodeAssert.equal(decide([reading("a", { read: "none" }), reading("b")]), "b");
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
    "creates nothing while a Star is held, Show Star is off, every environment was tried, or none has the plugin",
    () => {
      NodeAssert.equal(decide([reading("a")], { stars: 1 }), undefined);
      NodeAssert.equal(decide([reading("a", { read: "none" })]), undefined);
      NodeAssert.equal(decide([reading("a")], { enabled: false }), undefined);
      NodeAssert.equal(decide([reading("a", { attempted: true })]), undefined);
    },
  );

  NodeTest.test(
    "creates nothing while a ready environment's Stars failed to read, since it may hold the Star",
    () => {
      NodeAssert.equal(decide([reading("a", { read: "failed" }), reading("b")]), undefined);
      NodeAssert.equal(decide([reading("a"), reading("b", { read: "failed" })]), undefined);
    },
  );

  NodeTest.test("creates nothing on another environment after a creation failed", () => {
    NodeAssert.equal(
      decide([reading("a", { attempted: true }), reading("b")], { halted: true }),
      undefined,
    );
  });
});
