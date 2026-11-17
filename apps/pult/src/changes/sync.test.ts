import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { decodeKept } from "../stars/plugin.ts";
import {
  afterStep,
  KEPT_STUCK_MS,
  keptStateLine,
  failedRead,
  hasSync,
  pullFailure,
  syncAction,
  syncState,
  syncSteps,
  syncTitle,
  syncTooltip,
  type XaxisState,
  xaxisStateLine,
} from "./sync.ts";

const state = (
  ahead: number,
  behind: number,
  hasUpstream = true,
  branch: string | null = "main",
) => ({ branch, hasUpstream, ahead, behind, xaxis: null });

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

/** An xaxis checkout's state as the server's status gives it: a stack of `ahead`, main `behind` past its base. */
const xaxisState = (
  ahead: number,
  behind: number,
  xaxis: Partial<{
    conflicts: XaxisState["conflicts"];
    interrupted: XaxisState["interrupted"];
    xaxisTip: "signed-out" | "unreachable";
  }> = {},
) =>
  syncState({
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: ahead,
    behindCount: behind,
    pr: null,
    xaxis: { conflicts: xaxis.conflicts ?? [], interrupted: xaxis.interrupted ?? null },
    ...(xaxis.xaxisTip === undefined ? {} : { xaxisTip: xaxis.xaxisTip }),
  })!;

const button = (uncommitted: boolean, sync: ReturnType<typeof xaxisState>) => {
  const action = syncAction(uncommitted, sync);
  if (!("title" in action)) throw new Error(`not an xaxis button: ${action.kind}`);
  return [action.title, action.enabled, action.tooltip];
};

const line = (sync: ReturnType<typeof xaxisState>, uncommitted = 0) =>
  xaxisStateLine(sync, sync.xaxis!, uncommitted).map((item) => [item.title, item.click]);

const CONFLICT = { path: "notes/a.md", markers: true };

NodeTest.describe("an xaxis checkout", () => {
  NodeTest.test("commits and lands uncommitted changes or a stack, behind or not", () => {
    NodeAssert.deepEqual(button(true, xaxisState(0, 3)), [
      "$(check) Commit & Land",
      true,
      "Commit every change and land it on main",
    ]);
    NodeAssert.deepEqual(button(false, xaxisState(2, 3)), [
      "$(check) Commit & Land",
      true,
      "Land 2 commits on main",
    ]);
  });

  NodeTest.test("gets the latest while only behind, and offers nothing in step with main", () => {
    NodeAssert.deepEqual(button(false, xaxisState(0, 3)), [
      "$(cloud-download) Get latest 3$(arrow-down)",
      true,
      "Bring 3 changes from main",
    ]);
    NodeAssert.deepEqual(button(false, xaxisState(0, 0))[1], false);
  });

  NodeTest.test(
    "offers Commit & Land while a conflict is pending, though Take latest left nothing to commit",
    () => {
      NodeAssert.deepEqual(button(false, xaxisState(0, 0, { conflicts: [CONFLICT] }))[1], true);
      // Listed with a clean working tree, so the button stays in reach.
      NodeAssert.equal(hasSync(xaxisState(0, 0, { conflicts: [CONFLICT] })), true);
      NodeAssert.equal(hasSync(xaxisState(0, 0)), false);
    },
  );

  NodeTest.test(
    "finishes an interrupted write with its verb, and leaves another to the CLI",
    () => {
      NodeAssert.equal(
        syncAction(true, xaxisState(1, 0, { interrupted: "get-latest" })).kind,
        "get-latest",
      );
      NodeAssert.equal(
        syncAction(false, xaxisState(0, 0, { interrupted: "commit-land" })).kind,
        "commit-land",
      );
      NodeAssert.deepEqual(
        button(false, xaxisState(0, 0, { interrupted: { command: "xaxis resolve --mine" } })),
        [
          "$(check) Commit & Land",
          false,
          "A write stopped partway: run `xaxis resolve --mine` in a terminal",
        ],
      );
    },
  );

  NodeTest.test("states the first that holds, uncommitted and behind together", () => {
    NodeAssert.deepEqual(line(xaxisState(1, 2, { conflicts: [CONFLICT, CONFLICT] }), 3), [
      ["Conflicts in 2 files", "open-conflict"],
    ]);
    NodeAssert.deepEqual(line(xaxisState(1, 2, { interrupted: "commit-land" }), 3), [
      ["Interrupted", null],
    ]);
    NodeAssert.deepEqual(line(xaxisState(1, 2), 1), [["1 uncommitted change · Behind by 2", null]]);
    NodeAssert.deepEqual(line(xaxisState(1, 2)), [["1 commit not landed", null]]);
    NodeAssert.deepEqual(line(xaxisState(0, 2)), [["Behind by 2", "get-latest"]]);
    NodeAssert.deepEqual(line(xaxisState(0, 0)), [["Up to date", null]]);
  });

  NodeTest.test("tells a tip it could not read beside the state", () => {
    NodeAssert.deepEqual(line(xaxisState(0, 0, { xaxisTip: "signed-out" })), [
      ["Up to date", null],
      ["Signed out of xaxis", null],
    ]);
    NodeAssert.deepEqual(line(xaxisState(0, 0, { xaxisTip: "unreachable" }))[1], [
      "Could not reach xaxis",
      null,
    ]);
  });

  NodeTest.test("keeps its words after a failed read, which the line tells", () => {
    const failed = failedRead(xaxisState(2, 0), "xaxis was not found at xaxis")!;
    NodeAssert.equal(syncAction(false, failed).kind, "commit-land");
    NodeAssert.deepEqual(xaxisStateLine(failed, failed.xaxis!, 0), [
      {
        title: "Could not read the checkout",
        tooltip: "xaxis was not found at xaxis",
        click: null,
      },
    ]);
    // A checkout never read as xaxis's behaves as a failed read does: nothing to sync.
    NodeAssert.equal(failedRead(state(1, 0), "boom"), undefined);
    NodeAssert.equal(failedRead(undefined, "boom"), undefined);
  });

  NodeTest.test("leaves a refused Get latest's reason to the CLI", () => {
    NodeAssert.equal(
      pullFailure(xaxisState(1, 2), "unlanded-changes: land them first"),
      "unlanded-changes: land them first",
    );
  });
});

NodeTest.describe("the kept xaxis checkout", () => {
  const NOW = Date.parse("2026-11-17T14:10:00Z");
  /** The plugin's `xaxis/kept` answer for a checkout, as the route sends it, and the items it adds. */
  const kept = (checkout: object, answer: object = {}) => {
    const decoded = decodeKept({
      folder: "/home/a/.pult/xaxis",
      checkouts: [
        {
          dir: "/home/a/.pult/xaxis",
          prefix: "/",
          projectId: "p1",
          last: null,
          agentThreads: [],
          ...checkout,
        },
      ],
      refused: [],
      ...answer,
    });
    return keptStateLine(decoded, decoded.checkouts[0], NOW).map((item) => [
      item.title,
      item.tooltip,
      item.click,
    ]);
  };
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  NodeTest.test("adds nothing while Get latest goes through or waits for the user", () => {
    NodeAssert.deepEqual(kept({ last: { at: at(1000), outcome: "moved" } }), []);
    NodeAssert.deepEqual(
      kept({
        last: {
          at: at(1000),
          outcome: "waiting",
          code: "uncommitted-edits",
          message: "Edits.",
        },
      }),
      [],
    );
  });

  NodeTest.test(
    "says it cannot keep up after a failed Get latest, the CLI's words its tooltip",
    () => {
      NodeAssert.deepEqual(
        kept({
          last: {
            at: at(1000),
            outcome: "failed",
            code: "signed-out",
            message: "Not signed in. Run `xaxis login`.",
          },
        }),
        [["$(warning) Can't keep up to date", "Not signed in. Run `xaxis login`.", null]],
      );
      // And when the CLI cannot list the checkouts at all.
      const unlisted = decodeKept({
        folder: "/f",
        checkouts: [],
        refused: [],
        unlisted: "xaxis was not found",
      });
      NodeAssert.deepEqual(keptStateLine(unlisted, undefined, NOW), [
        { title: "$(warning) Can't keep up to date", tooltip: "xaxis was not found", click: null },
      ]);
    },
  );

  NodeTest.test("calls a Get latest stuck once it has run five minutes", () => {
    NodeAssert.deepEqual(kept({ running: { since: at(KEPT_STUCK_MS - 1000) } }), []);
    const [[title]] = kept({ running: { since: at(KEPT_STUCK_MS) } }) as [[string]];
    const time = new Date(NOW - KEPT_STUCK_MS).toTimeString().slice(0, 5);
    NodeAssert.equal(title, `Get latest stuck since ${time}`);
  });

  NodeTest.test("names an agent working in it, a click away", () => {
    NodeAssert.deepEqual(
      kept({ agentThreads: ["t1", "t2"] }).map(([title, , click]) => [title, click]),
      [["$(warning) An agent is working in this checkout", { openThread: "t1" }]],
    );
  });

  NodeTest.test("fails loudly on an answer of another shape", () => {
    NodeAssert.throws(() => kept({ last: { at: at(0), outcome: "gone" } }), /outcome/);
  });
});
