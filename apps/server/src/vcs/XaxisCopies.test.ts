// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// Pult: a thread's copy of a checkout, made and removed through the worktree calls of
// `GitWorkflowService`, over a real `xaxis` against `scm-server serve` (xaxis
// `pult/tasks/thread-copies.task`, "Test plan"). Skipped, with the reason printed, unless
// XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the two binaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
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

  // `delegate_task` from a thread whose checkout is `parentDir`, in the project at `root`, each
  // dispatched command recorded and then refused.
  const delegateFrom = (parentDir: string, dispatched: Array<OrchestrationV2ServerCommand>) => {
    const threadId = ThreadId.make("thread:copies-parent");
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "gpt-5.4" };
    const projection = {
      thread: {
        id: threadId,
        projectId: ProjectId.make("project:copies"),
        worktreePath: parentDir,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: RunId.make("run:copies-parent"),
          ordinal: 1,
          status: "running",
          rootNodeId: NodeId.make("node:copies-root"),
          providerInstanceId: instanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-17T00:00:00.000Z",
      models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    } as ServerProvider;
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:copies"),
      requestNamespace: "provider-session:copies",
      thread: {
        threadId,
        providerSessionId: "provider-session:copies",
        providerInstanceId: instanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: () => Effect.succeed(projection),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            assertProviderInstanceEnabled: () => Effect.void,
            dispatch: (command) =>
              Effect.sync(() => dispatched.push(command)).pipe(
                Effect.andThen(Effect.fail({ _tag: "Refused" } as never)),
              ),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([provider]),
            refreshInstance: () => Effect.succeed([provider]),
          }),
          Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistryV2,
            ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
              list: () => Effect.succeed([instanceId]),
              get: () => Effect.succeed({ instanceId } as never),
            }),
          ),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeedSome({ id, title: "pult", workspaceRoot: root } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
    return OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap((mcp) =>
        mcp.delegateTask(scope, { task: "Build the unit.", isolation: "worktree" }),
      ),
      Effect.provide(service),
    );
  };

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

    it.effect(
      "cleans a settled thread's copy only when no thread is on it and it holds no work",
      () =>
        Effect.gen(function* () {
          const workflow = yield* GitWorkflowService.GitWorkflowService;
          const make = () =>
            workflow
              .createWorktree({ cwd: root, refName: "main", path: null })
              .pipe(Effect.map((result) => result.worktree.path));
          const clean = (path: string, activeThreadIds: ReadonlyArray<string> = []) =>
            workflow.cleanSettledCopy({ cwd: root, path, activeThreadIds });

          const shared = yield* make();
          assert.deepEqual(yield* clean(shared, ["thread:other"]), {
            removed: false,
            reason: "another thread is still on it",
          });
          assert.isTrue(NodeFS.existsSync(shared));
          assert.deepEqual(yield* clean(shared), { removed: true });
          assert.isFalse(NodeFS.existsSync(shared));

          const edited = yield* make();
          NodeFS.writeFileSync(NodePath.join(edited, "f.txt"), "edited\n");
          const keptEdit = yield* clean(edited);
          assert.isFalse(keptEdit?.removed);
          assert.include(
            keptEdit?.removed === false ? keptEdit.reason : "",
            "holds 1 uncommitted change",
          );
          assert.isTrue(NodeFS.existsSync(edited));

          const stacked = yield* make();
          NodeFS.writeFileSync(NodePath.join(stacked, "n.txt"), "new\n");
          committed(xaxis(stacked, "commit", "-m", "not landed"));
          const keptStack = yield* clean(stacked);
          assert.include(
            keptStack?.removed === false ? keptStack.reason : "",
            "holds 1 commit not landed",
          );
          assert.isTrue(NodeFS.existsSync(stacked));
        }),
    );

    // It moves main past the root's base, so it runs after the cases above.
    it.effect("delegates a child onto a copy at the parent's head, its stack inherited", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const parentDir = NodePath.join(harness.scratch, "parent");
        xaxis(harness.scratch, "--server", harness.address, "checkout", "/test/pult", "parent");
        NodeFS.writeFileSync(NodePath.join(parentDir, "n.txt"), "new\n");
        committed(xaxis(parentDir, "commit", "-m", "not landed"));
        const parent = JSON.parse(xaxis(parentDir, "status", "--json")) as XaxisCli.XaxisStatus;
        xaxis(harness.scratch, "--server", harness.address, "checkout", "/test/pult", "ahead");
        const ahead = NodePath.join(harness.scratch, "ahead");
        NodeFS.writeFileSync(NodePath.join(ahead, "f.txt"), "three\n");
        landed((xaxis(ahead, "commit", "-m", "third"), xaxis(ahead, "land")));

        const dispatched: Array<OrchestrationV2ServerCommand> = [];
        // The dispatch is refused once recorded, so the launch it would start never runs.
        yield* delegateFrom(parentDir, dispatched).pipe(Effect.flip);
        const [command] = dispatched;
        assert.equal(command?.type, "delegated_task.request");
        const strategy =
          command?.type === "delegated_task.request" ? command.workspaceStrategy : undefined;
        assert.isTrue(strategy?.type === "worktree" && strategy.startFromOrigin === false);
        const baseRef = strategy?.type === "worktree" ? strategy.baseRef : "";
        assert.match(baseRef, new RegExp(`^${parent.head}#[0-9a-f]{16}$`));
        // The changeset alone, as a tool would pass it, is no base.
        const alone = yield* workflow
          .createWorktree({ cwd: root, refName: parent.head, path: null })
          .pipe(Effect.flip);
        assert.equal(alone.detail, NO_BRANCHES);

        // As the launch makes the child's workspace from the strategy.
        const { worktree } = yield* workflow.createWorktree({
          cwd: root,
          refName: baseRef,
          newRefName: "t3/0a1b2c3d",
          baseRefName: baseRef,
          path: null,
        });
        assert.equal(worktree.refName, "main");
        assert.equal(NodeFS.readFileSync(NodePath.join(worktree.path, "f.txt"), "utf8"), "two\n");
        assert.equal(NodeFS.readFileSync(NodePath.join(worktree.path, "n.txt"), "utf8"), "new\n");
        const status = JSON.parse(xaxis(worktree.path, "status", "--json")) as XaxisCli.XaxisStatus;
        assert.equal(status.base, parent.base);
        assert.deepEqual(status.stack, parent.stack);
      }),
    );

    it.effect("fails a delegated copy the CLI refuses, by its code, leaving no folder", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        // A parent over more of the tree than the project, its commit outside the project's prefix.
        xaxis(harness.scratch, "--server", harness.address, "checkout", "/test", "wide");
        const wide = NodePath.join(harness.scratch, "wide");
        NodeFS.mkdirSync(NodePath.join(wide, "other"));
        NodeFS.writeFileSync(NodePath.join(wide, "other", "o.txt"), "o\n");
        committed(xaxis(wide, "commit", "-m", "outside"));

        const dispatched: Array<OrchestrationV2ServerCommand> = [];
        yield* delegateFrom(wide, dispatched).pipe(Effect.flip);
        const [command] = dispatched;
        const baseRef =
          command?.type === "delegated_task.request" &&
          command.workspaceStrategy?.type === "worktree"
            ? command.workspaceStrategy.baseRef
            : "";
        const before = copiesOfRoot();
        const refused = yield* workflow
          .createWorktree({ cwd: root, refName: baseRef, path: null })
          .pipe(Effect.flip);
        assert.equal(XaxisCli.refusalCode(refused), "checkout-stack-outside-prefix");
        assert.include(refused.detail, "(checkout-stack-outside-prefix)");
        assert.deepEqual(copiesOfRoot(), before);
      }),
    );
  });
});
