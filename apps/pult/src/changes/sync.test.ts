import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { afterStep, pullFailure, syncAction, syncSteps, syncTitle, syncTooltip } from "./sync.ts";

const state = (
  ahead: number,
  behind: number,
  hasUpstream = true,
  branch: string | null = "main",
) => ({ branch, hasUpstream, ahead, behind });

describe("syncAction", () => {
  test("commits while the working tree has changes, whatever there is to sync", () => {
    assert.deepEqual(syncAction(true, state(2, 1)), { kind: "commit", enabled: true });
  });

  test("syncs a clean checkout with commits to pull or push", () => {
    assert.deepEqual(syncAction(false, state(2, 0)), { kind: "sync", ahead: 2, behind: 0 });
    assert.deepEqual(syncAction(false, state(0, 3)), { kind: "sync", ahead: 0, behind: 3 });
  });

  test("offers no sync to a branch both ahead and behind, which a fast-forward pull refuses", () => {
    assert.deepEqual(syncAction(false, state(41, 1234)), {
      kind: "diverged",
      ahead: 41,
      behind: 1234,
    });
  });

  test("publishes a branch with no upstream, but not a detached HEAD", () => {
    assert.deepEqual(syncAction(false, state(0, 0, false)), { kind: "publish" });
    assert.deepEqual(syncAction(false, state(0, 0, false, null)), {
      kind: "commit",
      enabled: false,
    });
  });

  test("offers nothing to a checkout in step with its upstream, or one not read yet", () => {
    assert.deepEqual(syncAction(false, state(0, 0)), { kind: "commit", enabled: false });
    assert.deepEqual(syncAction(false, undefined), { kind: "commit", enabled: false });
  });
});

describe("sync", () => {
  test("pulls before it pushes, and only what is due", () => {
    assert.deepEqual(syncSteps(state(2, 1)), ["pull", "push"]);
    assert.deepEqual(syncSteps(state(2, 0)), ["push"]);
    assert.deepEqual(syncSteps(state(0, 1)), ["pull"]);
  });

  test("counts what comes down, then what goes up", () => {
    assert.equal(syncTitle("sync", 2, 1), "$(sync) Sync Changes 1$(arrow-down) 2$(arrow-up)");
    assert.equal(syncTitle("sync", 2, 0), "$(sync) Sync Changes 2$(arrow-up)");
    assert.equal(
      syncTitle("diverged", 41, 1234),
      "$(git-compare) Diverged 1234$(arrow-down) 41$(arrow-up)",
    );
    assert.equal(syncTooltip(2, 1), "Pull 1 commit, then push 2 commits");
  });

  test("counts what a step did before the status read confirms it", () => {
    assert.deepEqual(afterStep(state(1, 2), "pull"), state(1, 0));
    assert.deepEqual(afterStep(state(1, 0), "push"), state(0, 0));
    assert.deepEqual(afterStep(state(0, 0, false, "feat"), "push"), state(0, 0, true, "feat"));
    assert.deepEqual(afterStep(state(1, 0), "commit"), state(2, 0));
    assert.deepEqual(afterStep(state(0, 0, false, "feat"), "commit"), state(0, 0, false, "feat"));
  });

  test("names a diverged branch as the reason a pull failed", () => {
    assert.match(pullFailure(state(2, 1), "git pull failed"), /diverged/);
    assert.equal(pullFailure(state(0, 1), "git pull failed"), "git pull failed");
  });
});
