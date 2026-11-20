// Run with `node --test src/stars/sync.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { starsOf } from "./stars.ts";
import {
  handoffMessage,
  handoffModel,
  handoffThreadId,
  handoffTurn,
  handsOffNow,
  homeSleeps,
  type HomeStatus,
  originOf,
  originProblem,
  ownRepository,
  refusedByGit,
  sleepOccasions,
  syncPlan,
} from "./sync.ts";

const synced: HomeStatus = {
  repositoryRoot: "/Users/a/.pult/stars/vega",
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
    const fresh = { ...synced, hasUpstream: false, uncommitted: ["AGENTS.md"] };
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
      syncPlan({ ...synced, uncommitted: ["notes.md"] }, "full", {}),
      run(true, true, true),
    );
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 2 }, "full", {}), run(true, false, true));
    NodeAssert.deepEqual(
      syncPlan({ ...synced, behind: 3, uncommitted: ["x"] }, "pull", {}),
      run(true, false, false),
    );
  });

  NodeTest.test("without an origin, commits and neither pulls nor pushes", () => {
    const local = { ...synced, hasUpstream: false, uncommitted: ["instructions.md"] };
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
    repository: "~/.pult/stars/vega",
    branch: "main",
    uncommitted: ["notes.md"],
  };

  NodeTest.test(
    "says what diverged, the files involved, and asks the Star to reconcile and push",
    () => {
      const text = handoffMessage(input);
      NodeAssert.match(
        text,
        /your folder's repository, `~\/.pult\/stars\/vega` on laptop, with its origin.*`main` and `origin\/main` have diverged/,
      );
      NodeAssert.match(text, /- `notes.md`/);
      NodeAssert.match(text, /push to `origin\/main`/);
      NodeAssert.equal(text, handoffMessage(input));
      NodeAssert.doesNotMatch(handoffMessage({ ...input, uncommitted: [] }), /not committed/);
    },
  );

  NodeTest.test("is one thread per repository and state of both sides", async () => {
    const home = {
      environmentId: "env",
      root: "/home/me/.pult/stars/vega",
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

  NodeTest.test(
    "creates its thread and its first turn at the Star's choice, else at the conversation's",
    () => {
      const conversation = {
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      const chosen = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.2-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const turn = (choice: typeof chosen | null) =>
        handoffTurn({
          threadId: ThreadId.make("handoff"),
          projectId: ProjectId.make("star"),
          messageId: MessageId.make("m"),
          text: "Reconcile.",
          createdAt: "2026-11-20T12:00:00.000Z",
          chosen: choice,
          conversation,
        });
      const at = (each: ReturnType<typeof turn>) => [
        each.threadId,
        each.modelSelection,
        each.bootstrap.createThread.modelSelection,
        each.runtimeMode,
        each.bootstrap.createThread.runtimeMode,
      ];
      NodeAssert.deepEqual(at(turn(chosen)), [
        "handoff",
        chosen,
        chosen,
        "full-access",
        "full-access",
      ]);
      NodeAssert.deepEqual(at(turn(null)), [
        "handoff",
        conversation.modelSelection,
        conversation.modelSelection,
        "full-access",
        "full-access",
      ]);
    },
  );

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

NodeTest.describe("a Star's own repository", () => {
  const home = { root: "/Users/a/.pult/stars/vega/", directory: "/Users/a/.pult/stars" };
  /** A server whose status puts the folder in `holder`'s repository until `init` makes it its own. */
  const server = (holder: string | null) => {
    const calls: string[] = [];
    let repositoryRoot = holder;
    return {
      calls,
      status: async (root: string) => {
        calls.push(`status ${root}`);
        return { ...synced, repositoryRoot };
      },
      init: async (root: string) => {
        calls.push(`init ${root}`);
        repositoryRoot = root.replace(/\/$/, "");
      },
    };
  };

  NodeTest.test("is left as it is where the folder is its root", async () => {
    const git = server("/Users/a/.pult/stars/vega");
    await ownRepository(git, home);
    NodeAssert.deepEqual(git.calls, [`status ${home.root}`]);
  });

  NodeTest.test(
    "is made in place where no repository holds the folder, or another one does",
    async () => {
      for (const holder of [null, "/Users/a"]) {
        const git = server(holder);
        await ownRepository(git, home);
        NodeAssert.deepEqual(git.calls, [
          `status ${home.root}`,
          `init ${home.root}`,
          `status ${home.root}`,
        ]);
      }
    },
  );

  NodeTest.test(
    "is refused, and nothing written, where the Stars directory is still one repository for every Star",
    async () => {
      const git = server("/Users/a/.pult/stars");
      await NodeAssert.rejects(ownRepository(git, home), {
        message:
          "/Users/a/.pult/stars is still one repository for every Star, which Pult no longer commits: each Star's folder must be a repository of its own.",
      });
      NodeAssert.deepEqual(git.calls, [`status ${home.root}`]);
    },
  );
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
  /** An environment's answer naming the Star's `work` conversation open in `threadId`. */
  const answer = (environmentId: string, threadId: string) => ({
    environmentId,
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
          channels: [{ slug: "work", threadId, sleeps: { at: CREATED } }],
          asleepSince: CREATED,
          model: null,
          conversations: [],
          schedules: [],
          asks: [],
        },
      ],
    },
  });
  /** The Star whose plugin last named `work`'s conversation `w` open, over the page's threads. */
  const starOver = (threads: ReadonlyArray<ReturnType<typeof thread>>) => {
    const [only] = starsOf([answer("env", "w")], threads);
    NodeAssert.ok(only !== undefined);
    return only;
  };
  // `user` has slept, its transcript written, while `work` is still open.
  const workOpen = starOver([thread("u", true), thread("w", false)]);
  // Then `work` sleeps too, the page seeing its conversation settle.
  const allAsleep = starOver([thread("u", true), thread("w", true)]);

  const all = () => true;

  NodeTest.test("syncs nothing while another channel is open, `user` asleep", () => {
    NodeAssert.equal(workOpen.state, "awake");
    NodeAssert.equal(homeSleeps("env", workOpen, all), false);
    NodeAssert.deepEqual(sleepOccasions(new Map(), [workOpen], all).occasions, []);
  });

  NodeTest.test("syncs when the last open channel sleeps, and not again while it sleeps", () => {
    NodeAssert.equal(homeSleeps("env", allAsleep, all), true);
    const open = sleepOccasions(new Map(), [workOpen], all);
    NodeAssert.deepEqual(open.awake.get("env"), ["star"]);
    const slept = sleepOccasions(open.awake, [allAsleep], all);
    NodeAssert.deepEqual(slept.occasions, [{ environmentId: "env", starId: "star" }]);
    NodeAssert.deepEqual(sleepOccasions(slept.awake, [allAsleep], all).occasions, []);
    // An environment seen for the first time: a connect's occasion, not a sleep's.
    NodeAssert.deepEqual(sleepOccasions(new Map(), [allAsleep], all).occasions, []);
  });

  NodeTest.test("is each Star's own sleep, whatever the other Stars on the environment do", () => {
    const x = { id: "x", awakeOn: [] };
    const y = { id: "y", awakeOn: ["laptop"] };
    // X falls asleep while Y is awake on the same environment: X's occasion.
    const first = sleepOccasions(new Map([["laptop", ["x", "y"]]]), [x, y], all);
    NodeAssert.deepEqual(first.occasions, [{ environmentId: "laptop", starId: "x" }]);
    NodeAssert.equal(homeSleeps("laptop", x, all), true);
    NodeAssert.equal(homeSleeps("laptop", y, all), false);
    // Then Y: its own.
    NodeAssert.deepEqual(sleepOccasions(first.awake, [x, { ...y, awakeOn: [] }], all).occasions, [
      { environmentId: "laptop", starId: "y" },
    ]);
  });

  NodeTest.test("is an occasion on each environment the Star slept on, and there alone", () => {
    const star = { id: "star", awakeOn: [] };
    const both = new Map([
      ["laptop", ["star"]],
      ["desk", ["star"]],
    ]);
    const { occasions, awake } = sleepOccasions(both, [star], all);
    NodeAssert.deepEqual(occasions, [
      { environmentId: "laptop", starId: "star" },
      { environmentId: "desk", starId: "star" },
    ]);
    NodeAssert.deepEqual(sleepOccasions(awake, [star], all).occasions, []);
    // Asleep on the laptop while a channel stays open on the desk: the laptop's occasion alone.
    const desk = { ...star, awakeOn: ["desk"] };
    NodeAssert.deepEqual(sleepOccasions(both, [desk], all).occasions, [
      { environmentId: "laptop", starId: "star" },
    ]);
    NodeAssert.equal(homeSleeps("laptop", desk, all), true);
    NodeAssert.equal(homeSleeps("desk", desk, all), false);
  });

  NodeTest.test(
    "keeps an environment not known as last seen, and catches its sleep once in",
    () => {
      const star = { id: "star", awakeOn: [] };
      const laptopOnly = (environmentId: string) => environmentId === "laptop";
      const loading = sleepOccasions(
        new Map([
          ["laptop", []],
          ["desk", ["star"]],
        ]),
        [star],
        laptopOnly,
      );
      NodeAssert.deepEqual(loading.occasions, []);
      NodeAssert.deepEqual(loading.awake.get("desk"), ["star"]);
      NodeAssert.equal(homeSleeps("desk", star, laptopOnly), false);
      NodeAssert.deepEqual(sleepOccasions(loading.awake, [star], all).occasions, [
        { environmentId: "desk", starId: "star" },
      ]);
    },
  );

  NodeTest.test(
    "keeps an environment whose Stars are missing while it is not known, and catches the sleep when they return",
    () => {
      const x = { id: "x", awakeOn: ["laptop"] };
      const first = sleepOccasions(new Map(), [x], all);
      // The laptop's read fails, dropping its Stars, and the laptop is not known until it answers again.
      const unread = () => false;
      const dropped = sleepOccasions(first.awake, [], unread);
      NodeAssert.deepEqual(dropped.occasions, []);
      NodeAssert.deepEqual(dropped.awake.get("laptop"), ["x"]);
      // The answer returns with X asleep: the sleep's occasion.
      NodeAssert.deepEqual(sleepOccasions(dropped.awake, [{ ...x, awakeOn: [] }], all).occasions, [
        { environmentId: "laptop", starId: "x" },
      ]);
    },
  );

  NodeTest.test("reads a Star awake on each environment where its home has a channel open", () => {
    const on = (environmentId: string, id: string, settled = false) => ({
      ...thread(id, settled),
      environmentId,
    });
    const answers = [answer("laptop", "l"), answer("desk", "d")];
    // `work` open on both homes, the desk's newer, so the Star's `work` is the desk's: the laptop's still writes there.
    const [both] = starsOf(answers, [
      on("laptop", "l"),
      { ...on("desk", "d"), createdAt: "2026-11-02T00:00:00.000Z" },
    ]);
    NodeAssert.ok(both !== undefined);
    NodeAssert.deepEqual(both.awakeOn, ["laptop", "desk"]);
    NodeAssert.equal(homeSleeps("laptop", both, all), false);
    // The laptop's conversation settled: the laptop sleeps while the desk's goes on.
    const [desk] = starsOf(answers, [on("laptop", "l", true), on("desk", "d")]);
    NodeAssert.ok(desk !== undefined);
    NodeAssert.deepEqual(desk.awakeOn, ["desk"]);
    NodeAssert.equal(homeSleeps("laptop", desk, all), true);
    NodeAssert.equal(homeSleeps("desk", desk, all), false);
  });

  NodeTest.test("a handoff deferred while a channel is open is delivered on that sleep", () => {
    const deferred = { sleeps: false, writing: false, occasion: "full" } as const;
    NodeAssert.equal(handsOffNow(deferred), false);
    NodeAssert.equal(handsOffNow({ ...deferred, sleeps: true }), true);
    NodeAssert.equal(handsOffNow({ ...deferred, sleeps: true, writing: true }), false);
    NodeAssert.equal(handsOffNow({ ...deferred, sleeps: true, occasion: "pull" }), false);
  });
});
