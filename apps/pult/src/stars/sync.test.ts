// Run with `node --test src/stars/sync.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { starsOf } from "./stars.ts";
import {
  fellAsleep,
  handoffMessage,
  handoffModel,
  handoffThreadId,
  handsOffNow,
  type HomeStatus,
  originOf,
  originProblem,
  refusedByGit,
  sleepOccasions,
  syncPlan,
  syncsNow,
} from "./sync.ts";

const synced: HomeStatus = {
  ownRepository: true,
  branch: "main",
  head: "a".repeat(40),
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  uncommitted: [],
};

NodeTest.describe("originProblem", () => {
  NodeTest.test("takes SSH URLs, plain HTTPS ones and absolute paths", () => {
    for (const url of [
      "git@github.com:me/star.git",
      "ssh://git@host/me/star.git",
      "https://github.com/me/star.git",
      "/srv/star.git",
      "file:///srv/star.git",
    ])
      NodeAssert.equal(originProblem(url), undefined, url);
  });

  NodeTest.test("refuses an empty origin, spaces, and a relative path", () => {
    NodeAssert.notEqual(originProblem(" "), undefined);
    NodeAssert.notEqual(originProblem("/srv/my star.git"), undefined);
    NodeAssert.notEqual(originProblem("star.git"), undefined);
    NodeAssert.notEqual(originProblem("~/star.git"), undefined);
  });
});

NodeTest.test(
  "originOf reads origin's URL from a repository's config, and no other remote's",
  () => {
    const config = `[core]\n\turl = not-this\n[remote "upstream"]\n\turl = git@host:them/stars.git\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = git@host:me/stars.git\n[branch "main"]\n\tremote = origin\n`;
    NodeAssert.equal(originOf(config), "git@host:me/stars.git");
    NodeAssert.equal(
      originOf('[remote "origin"]\r\n  url = "/srv/stars.git"\r\n'),
      "/srv/stars.git",
    );
    NodeAssert.equal(originOf('[remote "upstream"]\n\turl = x\n'), undefined);
    NodeAssert.equal(originOf(""), undefined);
  },
);

NodeTest.describe("syncPlan", () => {
  const run = (pull: boolean, commit: boolean, push: boolean) => ({
    kind: "run",
    pull,
    commit,
    push,
  });

  NodeTest.test("publishes a branch the origin lacks, committing what is uncommitted first", () => {
    const fresh = { ...synced, hasUpstream: false, uncommitted: ["star/AGENTS.md"] };
    NodeAssert.deepEqual(syncPlan(fresh, "full", {}), run(false, true, true));
    NodeAssert.deepEqual(syncPlan(fresh, "pull", {}), run(false, false, false));
    // A new origin without the branch: its stale upstream neither pulls nor diverges.
    const repointed = { ...synced, ahead: 1, behind: 4 };
    NodeAssert.deepEqual(
      syncPlan(repointed, "full", { published: false }),
      run(false, false, true),
    );
  });

  NodeTest.test("always pulls a tracked branch, and pushes only what it has to", () => {
    NodeAssert.deepEqual(syncPlan(synced, "full", {}), run(true, false, false));
    NodeAssert.deepEqual(
      syncPlan({ ...synced, uncommitted: ["star/notes.md"] }, "full", {}),
      run(true, true, true),
    );
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 2 }, "full", {}), run(true, false, true));
    NodeAssert.deepEqual(
      syncPlan({ ...synced, behind: 3, uncommitted: ["x"] }, "pull", {}),
      run(true, false, false),
    );
  });

  NodeTest.test("without an origin, commits and neither pulls nor pushes", () => {
    const local = { ...synced, hasUpstream: false, uncommitted: ["star/instructions.md"] };
    NodeAssert.deepEqual(syncPlan(local, "full", { remote: false }), run(false, true, false));
    NodeAssert.deepEqual(
      syncPlan({ ...synced, ahead: 1, behind: 1 }, "full", { remote: false }),
      run(false, false, false),
    );
  });

  NodeTest.test("commits and pushes a change of the record it writes after the pull", () => {
    NodeAssert.deepEqual(syncPlan(synced, "full", { writes: true }), run(true, true, true));
  });

  NodeTest.test("hands a branch both ahead and behind to the Star, by the counts alone", () => {
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 1, behind: 1 }, "pull", {}), {
      kind: "diverged",
    });
  });
});

NodeTest.test("refusedByGit takes the refusals the server names, and nothing else", () => {
  const failed = (detail: string, reason?: string) =>
    `Git command failed in GitVcsDriver.pullCurrentBranch.pull (/home/me/.pult/stars/star): ${detail}${reason === undefined ? "" : ` (${reason})`}`;
  NodeAssert.equal(refusedByGit(failed("cannot fast-forward", "pull_not_fast_forward")), true);
  NodeAssert.equal(refusedByGit(failed("would overwrite", "pull_would_overwrite_changes")), true);
  NodeAssert.equal(refusedByGit(failed("rejected", "push_rejected_non_fast_forward")), true);
  NodeAssert.equal(refusedByGit(failed("Git could not update a local reference.")), false);
  NodeAssert.equal(refusedByGit(failed("git pull failed")), false);
  NodeAssert.equal(refusedByGit(failed("unreachable", "remote_unreachable")), false);
});

NodeTest.describe("the handoff", () => {
  const input = {
    environmentName: "laptop",
    repository: "~/.pult/stars",
    branch: "main",
    uncommitted: ["star/notes.md"],
  };

  NodeTest.test(
    "says what diverged, the files involved, and asks the Star to reconcile and push",
    () => {
      const text = handoffMessage(input);
      NodeAssert.match(
        text,
        /the Stars' repository, `~\/.pult\/stars` on laptop, with its origin.*`main` and `origin\/main` have diverged/,
      );
      NodeAssert.match(text, /- `star\/notes.md`/);
      NodeAssert.match(text, /push to `origin\/main`/);
      NodeAssert.equal(text, handoffMessage(input));
      NodeAssert.doesNotMatch(handoffMessage({ ...input, uncommitted: [] }), /not committed/);
    },
  );

  NodeTest.test("is one thread per repository and state of both sides", async () => {
    const home = {
      environmentId: "env",
      root: "/home/me/.pult/stars",
      branch: "main",
      head: "b".repeat(40),
      behind: 1,
    };
    const id = await handoffThreadId(home);
    NodeAssert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    NodeAssert.equal(await handoffThreadId({ ...home }), id);
    NodeAssert.notEqual(await handoffThreadId({ ...home, head: "c".repeat(40) }), id);
    NodeAssert.notEqual(await handoffThreadId({ ...home, behind: 2 }), id);
    NodeAssert.notEqual(await handoffThreadId({ ...home, environmentId: "other" }), id);
  });

  NodeTest.test("wakes `user` at `user`'s newest model, else at any channel's newest", () => {
    const conversation = (id: string, environmentId: string, channel?: string) => ({
      id,
      environmentId,
      tags: channel === undefined ? [] : [`pult:channel:${channel}`],
    });
    // Newest first: `work` ran last, on this environment.
    const conversations = [
      conversation("work-here", "env", "work"),
      conversation("user-there", "other"),
      conversation("user-here", "env", "user"),
      conversation("user-older", "env"),
    ];
    NodeAssert.equal(handoffModel(conversations, "env")?.id, "user-here");
    NodeAssert.equal(handoffModel(conversations, "far")?.id, "user-there");
    const noUser = [conversation("review", "other", "review"), conversation("work", "env", "work")];
    NodeAssert.equal(handoffModel(noUser, "env")?.id, "work");
    NodeAssert.equal(handoffModel(noUser, "far")?.id, "review");
    NodeAssert.equal(handoffModel([], "env"), undefined);
  });
});

NodeTest.describe("the sync on a Star's sleep", () => {
  const CREATED = "2026-11-01T00:00:00.000Z";
  const thread = (id: string, settled: boolean) => ({
    environmentId: "env",
    id,
    projectId: "star-project",
    parentId: null,
    settled,
    settledAt: null,
    createdAt: CREATED,
    working: false,
    workingSince: null,
    ageFrom: CREATED,
  });
  /** The Star whose plugin last named `work`'s conversation `w` open, over the page's threads. */
  const starOver = (threads: ReadonlyArray<ReturnType<typeof thread>>) => {
    const [only] = starsOf(
      [
        {
          environmentId: "env",
          answer: {
            directory: "/Users/a/.pult/stars",
            hidden: [],
            stars: [
              {
                id: "star",
                name: "",
                tint: "amber",
                created: CREATED,
                root: "/Users/a/.pult/stars/star",
                projectId: "star-project",
                instructions: "/Users/a/.pult/stars/star/instructions.md",
                channels: [{ slug: "work", threadId: "w", sleeps: { at: CREATED } }],
                asleepSince: CREATED,
                model: null,
                conversations: [],
                schedules: [],
                asks: [],
              },
            ],
          },
        },
      ],
      threads,
    );
    NodeAssert.ok(only !== undefined);
    return only;
  };
  // `user` has slept, its transcript written, while `work` is still open.
  const workOpen = starOver([thread("u", true), thread("w", false)]);
  // Then `work` sleeps too, the page seeing its conversation settle.
  const allAsleep = starOver([thread("u", true), thread("w", true)]);

  NodeTest.test("syncs nothing while another channel is open, `user` asleep", () => {
    NodeAssert.equal(workOpen.state, "awake");
    NodeAssert.equal(syncsNow(workOpen), false);
    NodeAssert.deepEqual(fellAsleep(new Map(), [workOpen]), []);
  });

  NodeTest.test("syncs when the last open channel sleeps, and not again while it sleeps", () => {
    NodeAssert.equal(syncsNow(allAsleep), true);
    NodeAssert.deepEqual(fellAsleep(new Map([["star", workOpen.state]]), [allAsleep]), ["star"]);
    NodeAssert.deepEqual(fellAsleep(new Map([["star", "working"]]), [allAsleep]), ["star"]);
    NodeAssert.deepEqual(fellAsleep(new Map([["star", "asleep"]]), [allAsleep]), []);
    // A Star seen for the first time: a connect's occasion, not a sleep's.
    NodeAssert.deepEqual(fellAsleep(new Map(), [allAsleep]), []);
  });

  NodeTest.test("is an occasion on each of the Star's homes' environments", () => {
    const star = {
      id: "star",
      state: "asleep" as const,
      homes: [{ environmentId: "laptop" }, { environmentId: "desk" }],
    };
    const { occasions, states } = sleepOccasions(new Map([["star", "awake"]]), [star], () => true);
    NodeAssert.deepEqual(occasions, [
      { environmentId: "laptop", starId: "star" },
      { environmentId: "desk", starId: "star" },
    ]);
    NodeAssert.equal(states.get("star"), "asleep");
    NodeAssert.deepEqual(sleepOccasions(states, [star], () => true).occasions, []);
  });

  NodeTest.test("waits for every home's environment to be known, then is caught", () => {
    const star = {
      id: "star",
      state: "asleep" as const,
      homes: [{ environmentId: "laptop" }, { environmentId: "desk" }],
    };
    const loading = sleepOccasions(
      new Map([["star", "working"]]),
      [star],
      (environmentId) => environmentId === "laptop",
    );
    NodeAssert.deepEqual(loading.occasions, []);
    // Its state is not kept while it does not count, so the sleep stays to be seen.
    NodeAssert.equal(loading.states.get("star"), "working");
    NodeAssert.equal(sleepOccasions(loading.states, [star], () => true).occasions.length, 2);
  });

  NodeTest.test("a handoff deferred while a channel is open is delivered on that sleep", () => {
    const deferred = { state: workOpen.state, writing: false, occasion: "full" } as const;
    NodeAssert.equal(handsOffNow(deferred), false);
    NodeAssert.equal(handsOffNow({ ...deferred, state: allAsleep.state }), true);
    NodeAssert.equal(handsOffNow({ ...deferred, state: "asleep", writing: true }), false);
    NodeAssert.equal(handsOffNow({ ...deferred, state: "asleep", occasion: "pull" }), false);
  });
});
