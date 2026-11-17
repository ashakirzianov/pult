// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// Pult: a thread's copy of a checkout, made and removed through the worktree calls of
// `GitWorkflowService`, over a real `xaxis` against `scm-server serve` (xaxis
// `pult/issues/thread-copies`, "Test plan"). Skipped, with the reason printed, unless
// XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the two binaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as XaxisCli from "./XaxisCli.ts";
import { NO_BRANCHES } from "./XaxisCopies.ts";
import { XAXIS_MARKER } from "./XaxisVcsDriver.ts";
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

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe.skipIf(skipped)(suiteName("XaxisCopies"), () => {
  let harness: XaxisTestServer;
  let root = "";
  let whole = "";
  let worktrees = "";
  let first = "";
  const xaxis = (cwd: string, ...args: string[]) => harness.xaxis(cwd, ...args);
  const copiesOfRoot = () => {
    const folder = NodePath.join(worktrees, "pult");
    return NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder) : [];
  };
  const registered = () =>
    (
      JSON.parse(
        xaxis(harness.scratch, "checkouts", "--json"),
      ) as typeof XaxisCli.XaxisCheckouts.Type
    ).checkouts.map((checkout) => checkout.dir);

  beforeAll(async () => {
    harness = await startXaxisTestServer();
    const scratch = harness.scratch;
    worktrees = NodePath.join(scratch, "t3", "worktrees");
    xaxis(scratch, "--server", harness.address, "checkout", "/test/pult", "pult");
    root = NodePath.join(scratch, "pult");
    NodeFS.writeFileSync(NodePath.join(root, "f.txt"), "one\n");
    NodeFS.mkdirSync(NodePath.join(root, "sub"));
    NodeFS.writeFileSync(NodePath.join(root, "sub", "g.txt"), "x\n");
    first = landed((xaxis(root, "commit", "-m", "first"), xaxis(root, "land")));
    NodeFS.writeFileSync(NodePath.join(root, "f.txt"), "two\n");
    landed((xaxis(root, "commit", "-m", "second"), xaxis(root, "land")));
    xaxis(scratch, "--server", harness.address, "checkout", "/", "whole");
    whole = NodePath.join(scratch, "whole");
  });

  afterAll(() => harness?.stop());

  const layer = () =>
    GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provideMerge(XaxisVcsDriver.layer),
      Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerSettings.layerTest({ xaxisBinaryPath: XAXIS! })),
      Layer.provideMerge(
        ServerConfig.layerTest(harness.scratch, NodePath.join(harness.scratch, "t3")),
      ),
      Layer.provideMerge(platform),
    );

  it.layer(Layer.suspend(layer))("over a checkout's root", (it) => {
    it.effect("makes a copy of the root's prefix where worktrees go, on main, and clean", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const claimed: string[] = [];
        // As the launch asks: its temporary branch, and a base it did not fetch.
        assert.isNull(yield* workflow.fetchWorktreeBaseCommit({ cwd: root, refName: "main" }));
        assert.isFalse(yield* workflow.hasCommit({ cwd: root, refName: "refs/heads/t3" }));
        const { worktree } = yield* workflow.createWorktree(
          {
            cwd: root,
            refName: "main",
            newRefName: "t3/0a1b2c3d",
            baseRefName: "main",
            path: null,
          },
          { progress: { onWorktreeClaimed: (path) => Effect.sync(() => claimed.push(path)) } },
        );
        assert.equal(worktree.refName, "main");
        assert.deepEqual(claimed, [worktree.path]);
        assert.match(NodePath.relative(worktrees, worktree.path), /^pult\/copy-[0-9a-f]{8}$/);
        assert.equal(NodeFS.readFileSync(NodePath.join(worktree.path, "f.txt"), "utf8"), "two\n");
        assert.equal(
          NodeFS.readFileSync(NodePath.join(worktree.path, "sub", "g.txt"), "utf8"),
          "x\n",
        );
        assert.notEqual(
          NodeFS.readFileSync(NodePath.join(worktree.path, XAXIS_MARKER), "utf8"),
          NodeFS.readFileSync(NodePath.join(root, XAXIS_MARKER), "utf8"),
        );
        const status = JSON.parse(xaxis(worktree.path, "status", "--json")) as XaxisCli.XaxisStatus;
        assert.deepEqual([status.prefix, status.server], ["/test/pult", harness.address]);
        const local = yield* workflow.localStatus({ cwd: worktree.path });
        assert.deepEqual([local.refName, local.hasWorkingTreeChanges], ["main", false]);

        // As a turn's start recreates a missing one: at its recorded path, after the git questions.
        yield* workflow.removeWorktree({ cwd: root, path: worktree.path });
        yield* workflow.pruneWorktrees({ cwd: root });
        assert.deepEqual(yield* workflow.listLocalBranchNames(root), []);
        const recreated = yield* workflow.createWorktree({
          cwd: root,
          refName: "refs/heads/main",
          newRefName: "main",
          baseRefName: "refs/heads/main",
          path: worktree.path,
        });
        assert.deepEqual(recreated.worktree, { path: worktree.path, refName: "main" });
        assert.isTrue(NodeFS.existsSync(NodePath.join(worktree.path, "f.txt")));
      }),
    );

    it.effect("refuses a branch, another base, a folder inside a checkout and the whole tree", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const before = copiesOfRoot();
        const refusal = (input: { cwd: string; refName: string; newRefName?: string }) =>
          workflow.createWorktree({ ...input, path: null }).pipe(
            Effect.flip,
            Effect.map((error) => error.detail),
          );
        assert.equal(
          yield* refusal({ cwd: root, refName: "main", newRefName: "feat/x" }),
          NO_BRANCHES,
        );
        assert.equal(yield* refusal({ cwd: root, refName: first }), NO_BRANCHES);
        assert.include(
          yield* refusal({ cwd: NodePath.join(root, "sub"), refName: "main" }),
          "only a checkout's root gets a copy",
        );
        assert.include(
          yield* refusal({ cwd: whole, refName: "main" }),
          "a checkout of the whole tree, which is not copied",
        );
        assert.deepEqual(copiesOfRoot(), before);
      }),
    );

    it.effect("fails over a bad token and leaves no folder", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const before = copiesOfRoot();
        const claimed: string[] = [];
        const token = process.env.XAXIS_TOKEN;
        process.env.XAXIS_TOKEN = UNKNOWN_TOKEN;
        const error = yield* workflow
          .createWorktree(
            { cwd: root, refName: "main", path: null },
            { progress: { onWorktreeClaimed: (path) => Effect.sync(() => claimed.push(path)) } },
          )
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => (process.env.XAXIS_TOKEN = token))));
        assert.equal(XaxisCli.refusalCode(error), "unauthenticated");
        assert.lengthOf(claimed, 1);
        assert.isFalse(NodeFS.existsSync(claimed[0]!));
        assert.deepEqual(copiesOfRoot(), before);
      }),
    );

    it.effect("makes two copies at once", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const made = yield* Effect.forEach(
          [1, 2],
          () => workflow.createWorktree({ cwd: root, refName: "main", path: null }),
          { concurrency: "unbounded" },
        );
        const [a, b] = made.map((result) => result.worktree.path);
        assert.notEqual(a, b);
        for (const path of [a!, b!]) {
          assert.equal(NodeFS.readFileSync(NodePath.join(path, "f.txt"), "utf8"), "two\n");
        }
      }),
    );

    it.effect("removes a clean copy, edits only with force, and never a stack", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const make = () =>
          workflow
            .createWorktree({ cwd: root, refName: "main", path: null })
            .pipe(Effect.map((result) => result.worktree.path));

        const clean = yield* make();
        assert.include(registered(), clean);
        yield* workflow.removeWorktree({ cwd: root, path: clean });
        assert.isFalse(NodeFS.existsSync(clean));
        assert.notInclude(registered(), clean);

        const edited = yield* make();
        NodeFS.writeFileSync(NodePath.join(edited, "f.txt"), "edited\n");
        const kept = yield* workflow.removeWorktree({ cwd: root, path: edited }).pipe(Effect.flip);
        assert.include(kept.detail, "holds 1 uncommitted change");
        assert.isTrue(NodeFS.existsSync(edited));
        yield* workflow.removeWorktree({ cwd: root, path: edited, force: true });
        assert.isFalse(NodeFS.existsSync(edited));

        const stacked = yield* make();
        NodeFS.writeFileSync(NodePath.join(stacked, "n.txt"), "new\n");
        committed(xaxis(stacked, "commit", "-m", "not landed"));
        for (const force of [false, true]) {
          const refused = yield* workflow
            .removeWorktree({ cwd: root, path: stacked, force })
            .pipe(Effect.flip);
          assert.include(refused.detail, "holds 1 commit not landed");
        }
        assert.isTrue(NodeFS.existsSync(NodePath.join(stacked, "n.txt")));

        const own = yield* workflow
          .removeWorktree({ cwd: root, path: root, force: true })
          .pipe(Effect.flip);
        assert.include(own.detail, "the project's own checkout, not a copy");
        assert.isTrue(NodeFS.existsSync(root));
        const other = yield* workflow
          .removeWorktree({ cwd: root, path: whole, force: true })
          .pipe(Effect.flip);
        assert.include(other.detail, "is not a copy of the checkout at");
        assert.isTrue(NodeFS.existsSync(whole));
      }),
    );

    it.effect("checks a prefix out at a changeset on main", () =>
      Effect.gen(function* () {
        const cli = XaxisCli.make(yield* VcsProcess.VcsProcess, Effect.succeed(XAXIS!));
        const dir = NodePath.join(harness.scratch, "at-first");
        yield* cli.checkout({
          operation: "test.checkoutAt",
          cwd: harness.scratch,
          server: harness.address,
          prefix: "/test/pult",
          dir,
          at: first,
        });
        assert.equal(NodeFS.readFileSync(NodePath.join(dir, "f.txt"), "utf8"), "one\n");
        const status = JSON.parse(xaxis(dir, "status", "--json")) as XaxisCli.XaxisStatus;
        assert.equal(status.base, first);
      }),
    );
  });
});
