// Run with `node --test src/stars/stars.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { RouteStar, StarsAnswer } from "./plugin.ts";
import {
  cardRows,
  channelOf,
  channelRows,
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
  channels: [],
  asleepSince: CREATED,
  model: null,
  conversations: [],
  schedules: [],
  asks: [],
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
    tags: ReadonlyArray<string>;
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
  tags: [] as ReadonlyArray<string>,
  ...overrides,
});
const open = (slug: string, threadId: string) => ({
  slug,
  threadId,
  sleeps: { at: "2026-11-05T00:00:00.000Z" },
});

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

  NodeTest.test(
    "takes the live row of the conversation a home's plugin names as `user`'s current",
    () => {
      const threads = [
        thread("a", "older", "2026-11-01T00:00:00.000Z"),
        thread("b", "newer", "2026-11-02T00:00:00.000Z", { working: true }),
        thread("b", "unnamed", "2026-11-03T00:00:00.000Z"),
      ];
      const [star] = starsOf(
        [
          {
            environmentId: "a",
            answer: answer([routeStar("one", { channels: [open("user", "older")] })]),
          },
          {
            environmentId: "b",
            answer: answer([routeStar("one", { channels: [open("user", "newer")] })]),
          },
        ],
        threads,
      );
      NodeAssert.equal(star?.current?.id, "newer");
      NodeAssert.deepEqual(
        star?.channels.map(({ slug, thread }) => [slug, thread.id]),
        [["user", "newer"]],
      );
      NodeAssert.equal(star?.state, "working");
    },
  );

  const of = (channels: RouteStar["channels"], threads: ReturnType<typeof thread>[]) =>
    starsOf([{ environmentId: "a", answer: answer([routeStar("one", { channels })]) }], threads)[0];

  NodeTest.test("holds every open channel by slug, `user`'s alone the current conversation", () => {
    const star = of(
      [open("user", "u"), open("review-x", "r"), open("work", "w")],
      [thread("a", "u", CREATED), thread("a", "r", CREATED), thread("a", "w", CREATED)],
    );
    NodeAssert.deepEqual(
      star?.channels.map(({ slug, thread }) => [slug, thread.id]),
      [
        ["review-x", "r"],
        ["user", "u"],
        ["work", "w"],
      ],
    );
    NodeAssert.equal(star?.current?.id, "u");
  });

  NodeTest.test(
    "is awake while any channel is open, `user` asleep among them, and working while any works",
    () => {
      const working = of(
        [open("user", "u"), open("work", "w")],
        [thread("a", "u", CREATED), thread("a", "w", CREATED, { working: true })],
      );
      NodeAssert.equal(working?.state, "working");
      const userAsleep = of([open("work", "w")], [thread("a", "w", CREATED)]);
      NodeAssert.equal(userAsleep?.state, "awake");
      NodeAssert.equal(userAsleep?.current, null);
    },
  );

  NodeTest.test(
    "is asleep only while no channel is open: none named, or each seen settled or held by no row",
    () => {
      const asleep = (channels: RouteStar["channels"], threads: ReturnType<typeof thread>[]) =>
        of(channels, threads)?.state;
      NodeAssert.equal(asleep([], [thread("a", "t", CREATED)]), "asleep");
      NodeAssert.equal(
        asleep(
          [open("user", "u"), open("work", "w")],
          [
            thread("a", "u", CREATED, { settled: true }),
            thread("a", "w", CREATED, { settled: true }),
          ],
        ),
        "asleep",
      );
      NodeAssert.equal(asleep([open("work", "w")], []), "asleep");
      NodeAssert.equal(
        asleep(
          [open("user", "u"), open("work", "w")],
          [thread("a", "u", CREATED, { settled: true }), thread("a", "w", CREATED)],
        ),
        "awake",
      );
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

NodeTest.describe("channelRows", () => {
  NodeTest.test("lists every open channel but `user`, by slug", () => {
    const [star] = starsOf(
      [
        {
          environmentId: "a",
          answer: answer([
            routeStar("one", {
              channels: [open("work", "w"), open("user", "u"), open("build-unit-4", "b")],
            }),
          ]),
        },
      ],
      [thread("a", "u", CREATED), thread("a", "w", CREATED), thread("a", "b", CREATED)],
    );
    NodeAssert.deepEqual(star && channelRows(star).map(({ slug, thread }) => [slug, thread.id]), [
      ["build-unit-4", "b"],
      ["work", "w"],
    ]);
  });

  NodeTest.test(
    "lists none while only `user` is open, nor a channel the page has seen settle",
    () => {
      const [star] = starsOf(
        [
          {
            environmentId: "a",
            answer: answer([
              routeStar("one", { channels: [open("user", "u"), open("work", "w")] }),
            ]),
          },
        ],
        [thread("a", "u", CREATED), thread("a", "w", CREATED, { settled: true })],
      );
      NodeAssert.deepEqual(star && channelRows(star), []);
    },
  );
});

NodeTest.describe("cardRows", () => {
  const child = (id: string, createdAt: string, tags: ReadonlyArray<string>, settled = false) =>
    thread("a", id, createdAt, {
      projectId: "repo",
      tags: ["pult:child:star:one", ...tags],
      settled,
    });
  const starWith = (channels: ReturnType<typeof open>[], threads: ReturnType<typeof thread>[]) => {
    const [star] = starsOf(
      [{ environmentId: "a", answer: answer([routeStar("one", { channels })]) }],
      threads,
    );
    if (star === undefined) throw new Error("No Star.");
    return star;
  };
  const shape = (rows: ReturnType<typeof cardRows<ReturnType<typeof thread>>>) => ({
    children: rows.children.map(({ id }) => id),
    channels: rows.channels.map(({ slug, thread, children }) => [
      slug,
      thread?.id ?? null,
      children.map(({ id }) => id),
    ]),
  });

  NodeTest.test(
    "lists each child under its channel's row, `work` with none, `user`'s under the card, oldest first",
    () => {
      const threads = [
        thread("a", "u", CREATED),
        thread("a", "w", CREATED),
        thread("a", "b", CREATED),
        child("late", "2026-11-03T00:00:00.000Z", ["pult:channel:build"]),
        child("early", "2026-11-02T00:00:00.000Z", ["pult:channel:build"]),
        child("untagged", "2026-11-02T00:00:00.000Z", []),
        child("with-user", "2026-11-02T00:00:00.000Z", ["pult:channel:user"]),
        // Another Star's child, and a thread of no Star's.
        thread("a", "other", CREATED, { projectId: "repo", tags: ["pult:child:star:two"] }),
        thread("a", "plain", CREATED, { projectId: "repo" }),
      ];
      const star = starWith([open("user", "u"), open("work", "w"), open("build", "b")], threads);
      NodeAssert.deepEqual(shape(cardRows(star, threads)), {
        children: ["with-user"],
        channels: [
          ["build", "b", ["early", "late"]],
          ["work", "w", ["untagged"]],
        ],
      });
    },
  );

  NodeTest.test(
    "keeps a sleeping channel's row, reading Asleep, while a child is unsettled, and loses it after",
    () => {
      const unsettled = [
        thread("a", "u", CREATED),
        child("builder", CREATED, ["pult:channel:review"]),
      ];
      const asleep = starWith([open("user", "u")], unsettled);
      NodeAssert.deepEqual(shape(cardRows(asleep, unsettled)), {
        children: [],
        channels: [["review", null, ["builder"]]],
      });
      const settled = [
        thread("a", "u", CREATED),
        child("builder", CREATED, ["pult:channel:review"], true),
      ];
      NodeAssert.deepEqual(shape(cardRows(starWith([open("user", "u")], settled), settled)), {
        children: [],
        channels: [],
      });
    },
  );

  NodeTest.test(
    "lists no settled child, and keeps a channel row its conversation alone holds",
    () => {
      const threads = [
        thread("a", "w", CREATED),
        child("done", CREATED, ["pult:channel:work"], true),
        child("done-user", CREATED, ["pult:channel:user"], true),
      ];
      NodeAssert.deepEqual(shape(cardRows(starWith([open("work", "w")], threads), threads)), {
        children: [],
        channels: [["work", "w", []]],
      });
    },
  );

  NodeTest.test(
    "reads a conversation the page has seen settle as asleep, and lists no conversation as a child",
    () => {
      const threads = [
        thread("a", "w", CREATED, { settled: true }),
        // A thread the Star launched into its own project is a conversation, not a child.
        thread("a", "own", CREATED, { tags: ["pult:child:star:one", "pult:channel:work"] }),
        child("builder", CREATED, ["pult:channel:work"]),
      ];
      const star = starWith([open("work", "w")], [thread("a", "w", CREATED)]);
      NodeAssert.deepEqual(shape(cardRows(star, threads)), {
        children: [],
        channels: [["work", null, ["builder"]]],
      });
    },
  );
});

NodeTest.describe("channelOf", () => {
  NodeTest.test("reads the first valid channel tag, `user` where none is", () => {
    NodeAssert.equal(channelOf({ tags: [] }), "user");
    NodeAssert.equal(channelOf({ tags: ["pult:child:star:s1"] }), "user");
    NodeAssert.equal(channelOf({ tags: ["pult:channel:work"] }), "work");
    NodeAssert.equal(
      channelOf({ tags: ["pult:channel:Not A Slug", "pult:channel:review-2", "pult:channel:x"] }),
      "review-2",
    );
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
