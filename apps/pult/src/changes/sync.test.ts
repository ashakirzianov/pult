import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { afterStep, pullFailure, syncAction, syncSteps, syncTitle, syncTooltip } from "./sync.ts";

const state = (
  ahead: number,
  behind: number,
  hasUpstream = true,
  branch: string | null = "main",
) => ({ branch, hasUpstream, ahead, behind });

NodeTest.describe("syncAction", () => {
  NodeTest.test("commits while the working tree has changes, whatever there is to sync", () => {
    NodeAssert.deepEqual(syncAction(true, state(2, 1)), { kind: "commit", enabled: true });
  });

  NodeTest.test("syncs a clean checkout with commits to pull or push", () => {
    NodeAssert.deepEqual(syncAction(false, state(2, 0)), { kind: "sync", ahead: 2, behind: 0 });
    NodeAssert.deepEqual(syncAction(false, state(0, 3)), { kind: "sync", ahead: 0, behind: 3 });
  });

  NodeTest.test(
    "offers no sync to a branch both ahead and behind, which a fast-forward pull refuses",
    () => {
      NodeAssert.deepEqual(syncAction(false, state(41, 1234)), {
        kind: "diverged",
        ahead: 41,
        behind: 1234,
      });
    },
  );

  NodeTest.test("publishes a branch with no upstream, but not a detached HEAD", () => {
    NodeAssert.deepEqual(syncAction(false, state(0, 0, false)), { kind: "publish" });
    NodeAssert.deepEqual(syncAction(false, state(0, 0, false, null)), {
      kind: "commit",
      enabled: false,
    });
  });

  NodeTest.test(
    "offers nothing to a checkout in step with its upstream, or one not read yet",
    () => {
      NodeAssert.deepEqual(syncAction(false, state(0, 0)), { kind: "commit", enabled: false });
      NodeAssert.deepEqual(syncAction(false, undefined), { kind: "commit", enabled: false });
    },
  );
});

NodeTest.describe("sync", () => {
  NodeTest.test("pulls before it pushes, and only what is due", () => {
    NodeAssert.deepEqual(syncSteps(state(2, 1)), ["pull", "push"]);
    NodeAssert.deepEqual(syncSteps(state(2, 0)), ["push"]);
    NodeAssert.deepEqual(syncSteps(state(0, 1)), ["pull"]);
  });

  NodeTest.test("counts what comes down, then what goes up", () => {
    NodeAssert.equal(syncTitle("sync", 2, 1), "$(sync) Sync Changes 1$(arrow-down) 2$(arrow-up)");
    NodeAssert.equal(syncTitle("sync", 2, 0), "$(sync) Sync Changes 2$(arrow-up)");
    NodeAssert.equal(
      syncTitle("diverged", 41, 1234),
      "$(git-compare) Diverged 1234$(arrow-down) 41$(arrow-up)",
    );
    NodeAssert.equal(syncTooltip(2, 1), "Pull 1 commit, then push 2 commits");
  });

  NodeTest.test("counts what a step did before the status read confirms it", () => {
    NodeAssert.deepEqual(afterStep(state(1, 2), "pull"), state(1, 0));
    NodeAssert.deepEqual(afterStep(state(1, 0), "push"), state(0, 0));
    NodeAssert.deepEqual(afterStep(state(0, 0, false, "feat"), "push"), state(0, 0, true, "feat"));
    NodeAssert.deepEqual(afterStep(state(1, 0), "commit"), state(2, 0));
    NodeAssert.deepEqual(
      afterStep(state(0, 0, false, "feat"), "commit"),
      state(0, 0, false, "feat"),
    );
  });

  NodeTest.test("names a diverged branch as the reason a pull failed", () => {
    NodeAssert.match(pullFailure(state(2, 1), "git pull failed"), /diverged/);
    NodeAssert.equal(pullFailure(state(0, 1), "git pull failed"), "git pull failed");
  });
});
