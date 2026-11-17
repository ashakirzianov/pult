// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// Pult: an xaxis checkout's source control through the services the RPCs call, over a
// real `xaxis` against `scm-server serve` on a memory store (xaxis
// `pult/issues/xaxis-source-control`, "Test plan"). Skipped, with the reason printed,
// unless XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the two binaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GitActionProgressEvent, GitRunStackedActionInput } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import { XAXIS_HEAD_REF, XAXIS_TIP_REF } from "./XaxisVcsDriver.ts";
import * as XaxisCli from "./XaxisCli.ts";
import * as XaxisVcsDriver from "./XaxisVcsDriver.ts";
import {
  committed,
  landed,
  skipped,
  startXaxisTestServer,
  suiteName,
  UNKNOWN_TOKEN,
  XAXIS,
  type XaxisTestServer,
} from "./XaxisVcsDriver.testkit.ts";

const suite = suiteName("XaxisVcsDriver");

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe.skipIf(skipped)(suite, () => {
  let harness: XaxisTestServer;
  let scratch = "";
  let a = "";
  let b = "";
  const hashes = { first: "", stacked: "", other1: "", other2: "" };
  const xaxis = (cwd: string, ...args: string[]) => harness.xaxis(cwd, ...args);

  beforeAll(async () => {
    harness = await startXaxisTestServer();
    scratch = harness.scratch;
    xaxis(scratch, "--server", harness.address, "checkout", "/test/repo", "a");
    xaxis(scratch, "--server", harness.address, "checkout", "/test/repo", "b");
    a = NodePath.join(scratch, "a");
    b = NodePath.join(scratch, "b");
    NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "one\ntwo\n");
    NodeFS.mkdirSync(NodePath.join(a, "d"));
    NodeFS.writeFileSync(NodePath.join(a, "d", "g.txt"), "x\n");
    xaxis(a, "commit", "-m", "first files");
    hashes.first = landed(xaxis(a, "land"));
  });

  afterAll(() => harness?.stop());

  const layer = () =>
    Layer.mergeAll(GitWorkflowService.layer, ReviewService.layer).pipe(
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(true) }),
      ),
      Layer.provideMerge(XaxisVcsDriver.layer),
      Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerSettings.layerTest({ xaxisBinaryPath: XAXIS! })),
      Layer.provideMerge(ServerConfig.layerTest(scratch, { prefix: "t3-xaxis-config-" })),
      Layer.provideMerge(platform),
    );

  // One layer for the tests, so the tip one reads is the one the next shows; built once the checkouts are.
  it.layer(Layer.suspend(layer))("over two checkouts", (it) => {
    it.effect("reads a checkout's status: clean, edited, stacked, behind and signed out", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const clean = yield* workflow.localStatus({ cwd: a });
        assert.deepEqual(clean, {
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: true,
          refName: "main",
          headSha: hashes.first,
          hasWorkingTreeChanges: false,
          workingTree: { rootPath: a, files: [], insertions: 0, deletions: 0 },
          xaxis: { conflicts: [], interrupted: null },
        });

        NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "one\nTWO\nthree\n");
        hashes.stacked = committed(xaxis(a, "commit", "-m", "second\n\nits body", "f.txt"));
        NodeFS.rmSync(NodePath.join(a, "d", "g.txt"));
        NodeFS.writeFileSync(NodePath.join(a, "n.txt"), "new\n");
        // From a folder inside the checkout, its root's status.
        const edited = yield* workflow.localStatus({ cwd: NodePath.join(a, "d") });
        assert.equal(edited.headSha, hashes.stacked);
        assert.deepEqual(edited.workingTree, {
          rootPath: a,
          files: [
            { path: "d/g.txt", insertions: 0, deletions: 1 },
            { path: "n.txt", insertions: 1, deletions: 0 },
          ],
          insertions: 1,
          deletions: 1,
        });
        assert.deepEqual(edited.branchChanges, {
          baseRef: hashes.first,
          insertions: 2,
          deletions: 1,
        });
        assert.equal(yield* workflow.currentBranch(a), "main");

        NodeFS.writeFileSync(NodePath.join(b, "o.txt"), "other\n");
        xaxis(b, "commit", "-m", "from b");
        hashes.other1 = landed(xaxis(b, "land"));
        NodeFS.writeFileSync(NodePath.join(b, "o.txt"), "other again\n");
        xaxis(b, "commit", "-m", "from b again");
        hashes.other2 = landed(xaxis(b, "land"));
        assert.deepEqual(yield* workflow.remoteStatus({ cwd: a }), {
          hasUpstream: true,
          aheadCount: 1,
          behindCount: 2,
          pr: null,
        });

        const token = process.env.XAXIS_TOKEN;
        process.env.XAXIS_TOKEN = UNKNOWN_TOKEN;
        const signedOut = yield* workflow
          .remoteStatus({ cwd: a })
          .pipe(Effect.ensuring(Effect.sync(() => (process.env.XAXIS_TOKEN = token))));
        assert.deepEqual(signedOut, {
          hasUpstream: true,
          aheadCount: 1,
          behindCount: 0,
          pr: null,
          xaxisTip: "signed-out",
        });
      }),
    );

    it.effect("previews the edits, the stack, a commit and a file", () =>
      Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        // As a stock client asks it: whitespace and tracked-only hints answered with the whole preview.
        const preview = yield* review.getDiffPreview({
          cwd: a,
          ignoreWhitespace: true,
          trackedOnly: true,
        });
        assert.equal(preview.incomplete, undefined);
        const summary = preview.sources.map((source) => ({
          kind: source.kind,
          baseRef: source.baseRef,
          headRef: source.headRef,
          files: source.files,
        }));
        assert.deepEqual(summary, [
          {
            kind: "working-tree",
            baseRef: hashes.stacked,
            headRef: null,
            files: [
              { path: "d/g.txt", previousPath: null, additions: 0, deletions: 1 },
              { path: "n.txt", previousPath: null, additions: 1, deletions: 0 },
            ],
          },
          {
            kind: "branch-range",
            baseRef: hashes.first,
            headRef: hashes.stacked,
            files: [{ path: "f.txt", previousPath: null, additions: 2, deletions: 1 }],
          },
        ]);
        assert.include(preview.sources[0]!.diff, "+++ b/n.txt\n@@ -0,0 +1 @@\n+new\n");

        const file = yield* review.getDiffPreview({
          cwd: a,
          file: { path: "n.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.deepEqual(
          file.sources.map((source) => [source.kind, source.files?.map((stat) => stat.path)]),
          [["working-tree", ["n.txt"]]],
        );

        // A changeset of the checkout's own stack, and one landed from elsewhere, on main alone.
        const stacked = yield* review.getDiffPreview({
          cwd: a,
          commitSha: hashes.stacked,
          metadataOnly: true,
        });
        const [commit] = stacked.sources;
        assert.deepEqual(
          {
            kind: commit?.kind,
            title: commit?.title,
            commitSubject: commit?.commitSubject,
            baseRef: commit?.baseRef,
            headRef: commit?.headRef,
            patchesDeferred: commit?.patchesDeferred,
            diff: commit?.diff,
          },
          {
            kind: "commit",
            title: `Commit ${hashes.stacked.slice(7, 14)}`,
            commitSubject: "second",
            baseRef: hashes.first,
            headRef: hashes.stacked,
            patchesDeferred: true,
            diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n",
          },
        );
        const onMain = yield* review.getDiffPreview({ cwd: a, commitSha: hashes.other1 });
        assert.deepEqual(onMain.sources[0]?.files, [
          { path: "o.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }),
    );

    it.effect("reads both sides of each kind of change", () =>
      Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const sides = (input: {
          sourceKind: "working-tree" | "branch-range";
          changeType: "change" | "new" | "deleted";
          baseRef: string | null;
          headRef: string | null;
          path: string;
        }) =>
          review.getDiffFileContents({
            cwd: a,
            sourceKind: input.sourceKind,
            changeType: input.changeType,
            baseRef: input.baseRef,
            headRef: input.headRef,
            oldPath: input.path,
            newPath: input.path,
          });
        const { first, stacked } = hashes;
        const results = yield* Effect.all([
          sides({
            sourceKind: "working-tree",
            changeType: "deleted",
            baseRef: stacked,
            headRef: null,
            path: "d/g.txt",
          }),
          sides({
            sourceKind: "working-tree",
            changeType: "new",
            baseRef: stacked,
            headRef: null,
            path: "n.txt",
          }),
          // A side with no file at its changeset reads as empty.
          sides({
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: stacked,
            headRef: null,
            path: "n.txt",
          }),
          sides({
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: first,
            headRef: stacked,
            path: "f.txt",
          }),
        ]);
        assert.deepEqual(results, [
          { oldContents: "x\n", newContents: "" },
          { oldContents: "", newContents: "new\n" },
          { oldContents: "", newContents: "new\n" },
          { oldContents: "one\ntwo\n", newContents: "one\nTWO\nthree\n" },
        ]);
      }),
    );

    it.effect(
      "pages the log across the incoming line and the checkout's own, and lists the refs",
      () =>
        Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          const { first, stacked, other1, other2 } = hashes;
          const page = (input: { refs?: string[]; skip?: number; limit?: number }) =>
            review.getLog({ cwd: a, ...input }).pipe(
              Effect.map((result) => ({
                shas: result.commits.map((commit) => commit.sha),
                hasMore: result.hasMore,
              })),
            );
          const both = [XAXIS_HEAD_REF, XAXIS_TIP_REF];
          assert.deepEqual(yield* page({ refs: both, limit: 3 }), {
            shas: [other2, other1, stacked],
            hasMore: true,
          });
          assert.deepEqual(yield* page({ refs: both, skip: 3, limit: 3 }), {
            shas: [first],
            hasMore: false,
          });
          assert.deepEqual(yield* page({}), { shas: [stacked, first], hasMore: false });
          assert.deepEqual(yield* page({ refs: [XAXIS_TIP_REF] }), {
            shas: [other2, other1, first],
            hasMore: false,
          });
          assert.deepEqual(yield* page({ refs: [first], limit: 1 }), {
            shas: [first],
            hasMore: false,
          });
          // Several hashes, each placed on the incoming line or the checkout's own.
          assert.deepEqual(yield* page({ refs: [first, other1] }), {
            shas: [other1, first],
            hasMore: false,
          });
          assert.deepEqual(yield* page({ refs: [stacked, other1] }), {
            shas: [other1, stacked, first],
            hasMore: false,
          });
          assert.deepEqual(yield* page({ refs: [first, other1], skip: 1, limit: 1 }), {
            shas: [first],
            hasMore: false,
          });
          const nowhere = `sha256:${"0".repeat(64)}`;
          const unplaced = yield* Effect.flip(page({ refs: [stacked, nowhere] }));
          assert.include(unplaced.message, `${nowhere} is on neither`);

          const [tip, , head] = (yield* review.getLog({ cwd: a, refs: both, limit: 3 })).commits;
          assert.deepEqual(tip?.refs, [XAXIS_TIP_REF]);
          assert.deepEqual(
            {
              refs: head?.refs,
              parents: head?.parents,
              subject: head?.subject,
              message: head?.message,
              author: [head?.authorName, head?.authorEmail],
            },
            {
              refs: [XAXIS_HEAD_REF],
              parents: [first],
              subject: "second",
              message: "second\n\nits body",
              author: ["root", "/root"],
            },
          );

          assert.deepEqual(yield* review.getRefs({ cwd: a }), {
            head: { ref: XAXIS_HEAD_REF, sha: stacked },
            refs: [
              { name: XAXIS_HEAD_REF, sha: stacked, upstream: XAXIS_TIP_REF },
              { name: XAXIS_TIP_REF, sha: other2, upstream: null },
            ],
          });
        }),
    );

    it.effect("commits, lands, gets latest, and refuses what xaxis has not", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const events: GitActionProgressEvent[] = [];
        const act = (input: Omit<GitRunStackedActionInput, "actionId" | "cwd">) => {
          events.length = 0;
          return workflow.runStackedAction(
            { actionId: "action", cwd: a, ...input },
            {
              progressReporter: { publish: (event) => Effect.sync(() => void events.push(event)) },
            },
          );
        };
        const steps = () =>
          events.map((event) =>
            event.kind === "phase_started"
              ? `${event.kind}:${event.phase}`
              : event.kind === "action_started"
                ? `${event.kind}:${event.phases.join(",")}`
                : event.kind,
          );

        const pr = yield* Effect.flip(act({ action: "commit_push_pr", commitMessage: "x" }));
        assert.include(pr.message, "xaxis has no pull requests or branches");
        const unnamed = yield* Effect.flip(act({ action: "commit" }));
        assert.include(unnamed.message, "needs a message");

        const committed = yield* act({
          action: "commit",
          commitMessage: "third",
          filePaths: ["n.txt"],
        });
        const third = (yield* workflow.localStatus({ cwd: a })).headSha!;
        assert.deepEqual(
          { commit: committed.commit, push: committed.push, steps: steps() },
          {
            commit: { status: "created", commitSha: third, subject: "third" },
            push: { status: "skipped_not_requested" },
            steps: ["action_started:commit", "phase_started:commit", "action_finished"],
          },
        );
        assert.equal((yield* workflow.remoteStatus({ cwd: a }))?.aheadCount, 2);

        // Commit & Land: the deletion committed, the stack of three rebased onto b's landings.
        const review = yield* ReviewService.ReviewService;
        const shas = (refs: ReadonlyArray<string>) =>
          review
            .getLog({ cwd: a, refs: [...refs] })
            .pipe(Effect.map((result) => result.commits.map((commit) => commit.sha)));
        const refsOf = () =>
          review.getRefs({ cwd: a }).pipe(Effect.map((refs) => refs.refs.map((ref) => ref.sha)));
        const overMoved = yield* refsOf();
        const both = yield* act({ action: "commit_push", commitMessage: "fourth" });
        assert.deepEqual(
          { commit: both.commit.status, push: both.push, steps: steps() },
          {
            commit: "created",
            push: { status: "pushed", branch: "main" },
            steps: [
              "action_started:commit,push",
              "phase_started:commit",
              "phase_started:push",
              "action_finished",
            ],
          },
        );
        const landedAll = yield* workflow.localStatus({ cwd: a });
        assert.deepEqual(
          [landedAll.hasWorkingTreeChanges, landedAll.branchChanges],
          [false, undefined],
        );
        assert.equal(NodeFS.readFileSync(NodePath.join(a, "o.txt"), "utf8"), "other again\n");

        // Land alone, a commit made outside Pult; Commit & Land with nothing to commit lands too.
        NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "one\nTWO\nthree\nfour\n");
        xaxis(a, "commit", "-m", "fifth");
        const beforeLand = yield* refsOf();
        const land = yield* act({ action: "push" });
        // The Graph's stale head and tip after a land: their history as it is now.
        assert.deepEqual(yield* shas(beforeLand), yield* shas([XAXIS_HEAD_REF, XAXIS_TIP_REF]));
        assert.equal((yield* shas(beforeLand))[1], beforeLand[1]);
        // A land over a moved main rebased the stack, so its old head is nowhere.
        assert.include(
          (yield* Effect.flip(shas(overMoved))).message,
          `${overMoved[0]} is on neither`,
        );
        assert.deepEqual(
          [land.commit.status, land.push.status, steps()],
          [
            "skipped_not_requested",
            "pushed",
            ["action_started:push", "phase_started:push", "action_finished"],
          ],
        );
        NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "one\nTWO\nthree\nfour\nfive\n");
        xaxis(a, "commit", "-m", "sixth");
        const onlyLand = yield* act({ action: "commit_push", commitMessage: "unused" });
        assert.deepEqual(
          [onlyLand.commit.status, onlyLand.push.status],
          ["skipped_no_changes", "pushed"],
        );

        // b is behind a's landings: Get latest is refused over an edit, in the CLI's words,
        // then brings them, then is up to date.
        NodeFS.writeFileSync(NodePath.join(b, "e.txt"), "edit\n");
        const over = yield* Effect.flip(workflow.pullCurrentBranch(b));
        assert.include(over.message, "A goto is refused over uncommitted edits");
        NodeFS.rmSync(NodePath.join(b, "e.txt"));
        assert.equal((yield* workflow.pullCurrentBranch(b)).status, "pulled");
        assert.equal(NodeFS.readFileSync(NodePath.join(b, "n.txt"), "utf8"), "new\n");
        assert.deepEqual(yield* workflow.pullCurrentBranch(b), {
          status: "skipped_up_to_date",
          refName: "main",
          upstreamRef: null,
        });
      }),
    );

    it.effect("fails a land that conflicts, keeps mine, then commits and lands it", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const events: GitActionProgressEvent[] = [];
        const act = (input: Omit<GitRunStackedActionInput, "actionId" | "cwd">) =>
          workflow.runStackedAction(
            { actionId: "action", cwd: a, ...input },
            {
              progressReporter: { publish: (event) => Effect.sync(() => void events.push(event)) },
            },
          );

        NodeFS.writeFileSync(NodePath.join(b, "f.txt"), "from b\n");
        xaxis(b, "commit", "-m", "b's f");
        xaxis(b, "land");
        NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "from a\n");
        const failed = yield* Effect.flip(act({ action: "commit_push", commitMessage: "a's f" }));
        const sentence =
          "The land conflicted in 1 file: fix the markers or keep a side, then Commit & Land again.";
        assert.include(failed.message, sentence);
        assert.deepEqual(events.at(-1), {
          actionId: "action",
          cwd: a,
          action: "commit_push",
          kind: "action_failed",
          phase: "push",
          message: sentence,
        });
        assert.deepEqual((yield* workflow.localStatus({ cwd: a })).xaxis, {
          conflicts: [{ path: "f.txt", markers: true }],
          interrupted: null,
        });

        yield* workflow.resolveConflict({ cwd: a, paths: ["f.txt"], side: "mine" });
        assert.equal(NodeFS.readFileSync(NodePath.join(a, "f.txt"), "utf8"), "from a\n");
        assert.deepEqual((yield* workflow.localStatus({ cwd: a })).xaxis?.conflicts, [
          { path: "f.txt", markers: false },
        ]);

        const through = yield* act({ action: "commit_push", commitMessage: "a's f, kept" });
        assert.equal(through.push.status, "pushed");
        const after = yield* workflow.localStatus({ cwd: a });
        assert.deepEqual([after.hasWorkingTreeChanges, after.xaxis?.conflicts], [false, []]);

        // Take latest leaves nothing to commit: Commit & Land clears the conflict, landing none.
        xaxis(b, "goto");
        NodeFS.writeFileSync(NodePath.join(b, "f.txt"), "from b again\n");
        xaxis(b, "commit", "-m", "b's f again");
        xaxis(b, "land");
        NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "from a again\n");
        yield* Effect.flip(act({ action: "commit_push", commitMessage: "a's f again" }));
        yield* workflow.resolveConflict({ cwd: a, paths: ["f.txt"], side: "main" });
        const cleared = yield* act({ action: "commit_push", commitMessage: "take latest" });
        assert.deepEqual(
          [cleared.commit.status, cleared.push.status],
          ["skipped_no_changes", "skipped_up_to_date"],
        );
        const latest = yield* workflow.localStatus({ cwd: a });
        assert.deepEqual([latest.hasWorkingTreeChanges, latest.xaxis?.conflicts], [false, []]);
        assert.equal(NodeFS.readFileSync(NodePath.join(a, "f.txt"), "utf8"), "from b again\n");
      }),
    );

    it.effect("queues one checkout's verbs, so none meets the CLI's lock", () =>
      Effect.gen(function* () {
        const driver = yield* XaxisVcsDriver.XaxisVcsDriver;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        NodeFS.writeFileSync(NodePath.join(a, "q.txt"), "queued\n");
        xaxis(a, "commit", "-m", "for b to get");
        xaxis(a, "land");
        // Two Get latests at once: the second waits for the first, then finds main where it is.
        const twice = yield* Effect.all([driver.getLatest(b), driver.getLatest(b)], {
          concurrency: "unbounded",
        });
        assert.deepEqual(twice.map((result) => result.status).toSorted(), [
          "pulled",
          "skipped_up_to_date",
        ]);

        // A Get latest beside a Commit & Land: the land goes through, and the Get latest either
        // lands after it or waits on the edit or the stack, never on the lock.
        NodeFS.writeFileSync(NodePath.join(b, "q.txt"), "queued again\n");
        const [latest, both] = yield* Effect.all(
          [
            Effect.result(driver.getLatest(b)),
            workflow.runStackedAction({
              actionId: "action",
              cwd: b,
              action: "commit_push",
              commitMessage: "beside a Get latest",
            }),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(both.push.status, "pushed");
        if (latest._tag === "Failure")
          assert.include(
            ["uncommitted-edits", "unlanded-changes"],
            XaxisCli.refusalCode(latest.failure),
          );
      }),
    );
  });
});
