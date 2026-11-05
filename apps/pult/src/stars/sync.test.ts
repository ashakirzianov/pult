// Run with `node --test src/stars/sync.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  handoffMessage,
  handoffThreadId,
  type HomeStatus,
  originProblem,
  refCommit,
  refusedByGit,
  remoteUrl,
  syncPlan,
} from "./sync.ts";

const ORIGIN = "/srv/star.git";
const synced: HomeStatus = {
  ownRepository: true,
  remote: ORIGIN,
  branch: "main",
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
  NodeTest.test(
    "connects a plain folder, a folder inside another repository, and one whose origin is another",
    () => {
      NodeAssert.deepEqual(syncPlan({ ...synced, ownRepository: false }, ORIGIN, "full"), {
        kind: "connect",
      });
      NodeAssert.deepEqual(syncPlan({ ...synced, remote: null }, ORIGIN, "pull"), {
        kind: "connect",
      });
      NodeAssert.deepEqual(syncPlan({ ...synced, remote: "/srv/other.git" }, ORIGIN, "full"), {
        kind: "connect",
      });
      NodeAssert.equal(syncPlan({ ...synced, remote: `${ORIGIN}/` }, ORIGIN, "full").kind, "run");
    },
  );

  NodeTest.test(
    "publishes a branch without an upstream, committing what is uncommitted first",
    () => {
      const fresh = { ...synced, hasUpstream: false, uncommitted: ["AGENTS.md"] };
      NodeAssert.deepEqual(syncPlan(fresh, ORIGIN, "full"), {
        kind: "run",
        pull: false,
        commit: true,
        push: true,
      });
      NodeAssert.deepEqual(syncPlan(fresh, ORIGIN, "pull"), {
        kind: "run",
        pull: false,
        commit: false,
        push: false,
      });
    },
  );

  NodeTest.test("always pulls a tracked branch, and pushes only what it has to", () => {
    NodeAssert.deepEqual(syncPlan(synced, ORIGIN, "full"), {
      kind: "run",
      pull: true,
      commit: false,
      push: false,
    });
    NodeAssert.deepEqual(syncPlan({ ...synced, uncommitted: ["memory/a.md"] }, ORIGIN, "full"), {
      kind: "run",
      pull: true,
      commit: true,
      push: true,
    });
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 2 }, ORIGIN, "full"), {
      kind: "run",
      pull: true,
      commit: false,
      push: true,
    });
    NodeAssert.deepEqual(syncPlan({ ...synced, behind: 3, uncommitted: ["x"] }, ORIGIN, "pull"), {
      kind: "run",
      pull: true,
      commit: false,
      push: false,
    });
  });

  NodeTest.test("hands a branch both ahead and behind to the Star, by the counts alone", () => {
    NodeAssert.deepEqual(syncPlan({ ...synced, ahead: 1, behind: 1 }, ORIGIN, "pull"), {
      kind: "diverged",
    });
  });
});

NodeTest.test("refusedByGit tells git's refusals from failures to reach the origin", () => {
  NodeAssert.equal(refusedByGit("Git pull failed: not a fast-forward."), true);
  NodeAssert.equal(refusedByGit("Git command failed (remote_unreachable)."), false);
  NodeAssert.equal(refusedByGit("authentication_failed"), false);
});

NodeTest.test("remoteUrl reads origin's URL from .git/config", () => {
  const config =
    '[core]\n\tbare = false\n[remote "upstream"]\n\turl = /a\n[remote "origin"]\n\turl = git@host:me/star.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  NodeAssert.equal(remoteUrl(config), "git@host:me/star.git");
  NodeAssert.equal(remoteUrl("[core]\n"), null);
});

NodeTest.test("refCommit reads a loose ref, else packed-refs", () => {
  const sha = "a".repeat(40);
  NodeAssert.equal(refCommit(`${sha}\n`, undefined, "refs/remotes/origin/main"), sha);
  NodeAssert.equal(
    refCommit(
      undefined,
      `# pack-refs\n${sha} refs/remotes/origin/main\n`,
      "refs/remotes/origin/main",
    ),
    sha,
  );
  NodeAssert.equal(
    refCommit(undefined, `${sha} refs/remotes/origin/other\n`, "refs/remotes/origin/main"),
    null,
  );
});

NodeTest.describe("the handoff", () => {
  const divergence = {
    kind: "diverged",
    branch: "main",
    ahead: 2,
    behind: 1,
    uncommitted: ["memory/notes.md"],
  } as const;

  NodeTest.test(
    "says what diverged, the files involved, and asks the Star to reconcile and push",
    () => {
      const text = handoffMessage({
        environmentName: "laptop",
        folder: "~/.pult/stars/star",
        divergence,
      });
      NodeAssert.match(
        text,
        /`main` of your folder, `~\/.pult\/stars\/star` on laptop, and `origin\/main` have diverged: 2 commits here are not on the origin, and 1 commit there is not here/,
      );
      NodeAssert.match(text, /- `memory\/notes.md`/);
      NodeAssert.match(text, /push to `origin\/main`/);
      const refused = handoffMessage({
        environmentName: "laptop",
        folder: "~/.pult/stars/star",
        divergence: {
          kind: "refused",
          branch: "main",
          message:
            "Git command failed in GitVcsDriver.pullCurrentBranch.pull (/home/me/.pult/stars/star): git pull failed",
          uncommitted: [],
        },
      });
      NodeAssert.match(
        refused,
        /into your folder, `~\/.pult\/stars\/star` on laptop: git pull failed\n/,
      );
      NodeAssert.equal(
        text,
        handoffMessage({ environmentName: "laptop", folder: "~/.pult/stars/star", divergence }),
      );
    },
  );

  NodeTest.test(
    "is one thread per home and origin commit, however far the folder's own side has moved",
    async () => {
      const home = {
        environmentId: "env",
        root: "/home/me/.pult/stars/star",
        originCommit: "b".repeat(40),
      };
      const id = await handoffThreadId({ ...home, divergence });
      NodeAssert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      NodeAssert.equal(
        await handoffThreadId({ ...home, divergence: { ...divergence, ahead: 5 } }),
        id,
      );
      NodeAssert.notEqual(
        await handoffThreadId({ ...home, divergence, originCommit: "c".repeat(40) }),
        id,
      );
      NodeAssert.notEqual(
        await handoffThreadId({ ...home, divergence, environmentId: "other" }),
        id,
      );
    },
  );
});
