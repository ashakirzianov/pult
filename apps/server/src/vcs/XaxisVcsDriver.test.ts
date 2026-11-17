// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// Pult: an xaxis checkout's source control through the services the RPCs call, over a
// real `xaxis` against `scm-server serve` on a memory store (xaxis
// `pult/issues/xaxis-source-control`, "Test plan"). Skipped, with the reason printed,
// unless XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the two binaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import * as XaxisVcsDriver from "./XaxisVcsDriver.ts";

const XAXIS = process.env.XAXIS_TEST_BIN;
const SERVER = process.env.XAXIS_TEST_SERVER_BIN;
const skipped = !XAXIS || !SERVER;
// The reason rides the suite's name, which the reporter prints for a skipped suite.
const suite = skipped
  ? "XaxisVcsDriver (skipped: XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name no xaxis CLI and scm-server of JSON format 1)"
  : "XaxisVcsDriver";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe.skipIf(skipped)(suite, () => {
  let server: NodeChildProcess.ChildProcess | undefined;
  let scratch = "";
  let a = "";
  let b = "";
  const saved = { token: process.env.XAXIS_TOKEN, config: process.env.XAXIS_CONFIG_DIR };
  const hashes = { first: "", stacked: "", other1: "", other2: "" };

  const xaxis = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync(XAXIS!, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const committed = (output: string) => /as (sha256:[0-9a-f]{64})/.exec(output)![1]!;
  // A land rebases, so a changeset's landed hash is main's tip after it.
  const landed = (output: string) => /main is at (sha256:[0-9a-f]{64})/.exec(output)![1]!;

  beforeAll(async () => {
    scratch = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xaxis-")));
    const child = NodeChildProcess.spawn(SERVER!, ["serve", "--listen", "127.0.0.1:0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    server = child;
    let stdout = "";
    let stderr = "";
    const { address, token } = await new Promise<{ address: string; token: string }>(
      (resolve, reject) => {
        const check = () => {
          const listening = /"address":"([^"]+)"/.exec(stdout)?.[1];
          const root = /root key: (\S+)/.exec(stderr)?.[1];
          if (listening && root) resolve({ address: listening, token: root });
        };
        child.stdout!.on("data", (chunk) => ((stdout += chunk), check()));
        child.stderr!.on("data", (chunk) => ((stderr += chunk), check()));
        child.on("exit", (code) => reject(new Error(`scm-server exited ${code}: ${stderr}`)));
      },
    );
    // The CLI runs on the server's environment as it is: these are what it reads.
    process.env.XAXIS_TOKEN = token;
    process.env.XAXIS_CONFIG_DIR = NodePath.join(scratch, "config");
    xaxis(scratch, "--server", address, "checkout", "/test/repo", "a");
    xaxis(scratch, "--server", address, "checkout", "/test/repo", "b");
    a = NodePath.join(scratch, "a");
    b = NodePath.join(scratch, "b");
    NodeFS.writeFileSync(NodePath.join(a, "f.txt"), "one\ntwo\n");
    NodeFS.mkdirSync(NodePath.join(a, "d"));
    NodeFS.writeFileSync(NodePath.join(a, "d", "g.txt"), "x\n");
    xaxis(a, "commit", "-m", "first files");
    hashes.first = landed(xaxis(a, "land"));
  });

  afterAll(() => {
    // The PID captured at spawn, nothing found by name.
    server?.kill();
    process.env.XAXIS_TOKEN = saved.token;
    process.env.XAXIS_CONFIG_DIR = saved.config;
    if (saved.token === undefined) delete process.env.XAXIS_TOKEN;
    if (saved.config === undefined) delete process.env.XAXIS_CONFIG_DIR;
    if (scratch) NodeFS.rmSync(scratch, { recursive: true, force: true });
  });

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
        process.env.XAXIS_TOKEN = `xk:/root:${"0".repeat(64)}`;
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
  });
});
