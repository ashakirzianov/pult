// Run with `node --test src/stars/sync.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  handoffMessage,
  handoffThreadId,
  type HomeStatus,
  originProblem,
  refusedByGit,
  syncPlan,
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

  NodeTest.test(
    "refuses a token or a password in the URL, which AGENTS.md would carry to the origin",
    () => {
      NodeAssert.match(originProblem("https://ghp_abc@github.com/me/star.git") ?? "", /token/);
      NodeAssert.match(originProblem("https://me:secret@github.com/me/star.git") ?? "", /token/);
      NodeAssert.match(originProblem("ssh://me:secret@host/star.git") ?? "", /token/);
    },
  );

  NodeTest.test("refuses an empty origin, spaces, and a relative path", () => {
    NodeAssert.notEqual(originProblem(" "), undefined);
    NodeAssert.notEqual(originProblem("/srv/my star.git"), undefined);
    NodeAssert.notEqual(originProblem("star.git"), undefined);
    NodeAssert.notEqual(originProblem("~/star.git"), undefined);
  });
});

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
      syncPlan({ ...synced, uncommitted: ["memory/a.md"] }, "full", {}),
      run(true, true, true),
    );
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 2 }, "full", {}), run(true, false, true));
    NodeAssert.deepEqual(
      syncPlan({ ...synced, behind: 3, uncommitted: ["x"] }, "pull", {}),
      run(true, false, false),
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
    folder: "~/.pult/stars/star",
    branch: "main",
    uncommitted: ["memory/notes.md"],
  };

  NodeTest.test(
    "says what diverged, the files involved, and asks the Star to reconcile and push",
    () => {
      const text = handoffMessage(input);
      NodeAssert.match(
        text,
        /your folder, `~\/.pult\/stars\/star` on laptop, with its origin.*`main` and `origin\/main` have diverged/,
      );
      NodeAssert.match(text, /- `memory\/notes.md`/);
      NodeAssert.match(text, /push to `origin\/main`/);
      NodeAssert.equal(text, handoffMessage(input));
      NodeAssert.doesNotMatch(handoffMessage({ ...input, uncommitted: [] }), /not committed/);
    },
  );

  NodeTest.test("is one thread per home and state of both sides", async () => {
    const home = {
      environmentId: "env",
      root: "/home/me/.pult/stars/star",
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
});
