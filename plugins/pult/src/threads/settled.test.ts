import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextTransferId,
  type DiscoveredLocalServer,
  EventId,
  NodeId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";

import { Effect, FileSystem, Layer, MonoreVcsDriver } from "../host.ts";
import { at, fakeServer } from "../stars/testing.ts";
import * as SettledThreads from "./settled.ts";

const PROJECT = ProjectId.make("project-pult");
const NOW = "2026-11-26T12:00:00.000Z";

/** The reactions subscribed over a fake server, the warnings they log, and a way to commit an event. */
const harness = Effect.gen(function* () {
  const server = yield* fakeServer;
  const warnings: string[] = [];
  const logger = Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(JSON.stringify(message));
      }),
    ],
    { mergeWithExisting: false },
  );
  yield* SettledThreads.make().pipe(Effect.provide(Layer.merge(server.layer, logger)));
  yield* server.threads.events.taken(1);
  const commit = (
    type: "thread.settled" | "thread.archived" | "thread.unsettled",
    thread: { shell: OrchestrationV2ThreadShell },
  ) =>
    Effect.forEach(server.threads.events.items, ({ queue }) =>
      Queue.offer(queue, {
        type,
        id: EventId.make(`event:${type}:${thread.shell.id}`),
        threadId: thread.shell.id,
        occurredAt: at(NOW),
        payload: thread.shell,
      } as unknown as OrchestrationV2DomainEvent),
    );
  const settled = (id: string, shell: Partial<OrchestrationV2ThreadShell> = {}) =>
    server.threads.add(PROJECT, id, { settledOverride: "settled", settledAt: at(NOW), ...shell });
  return { server, warnings, commit, settled };
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const listening = (
  port: number,
  owner: Pick<DiscoveredLocalServer, "terminal" | "agent">,
): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}/`,
  processName: "node",
  pid: port + 10_000,
  ...owner,
});

describe("the settle reactions", () => {
  it.effect(
    "close the previews and stop the agent's servers of a settled thread, not a re-engaged one's, and an archived thread's previews",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        // Its settle is committed, but it is active again by the time the reaction reads it.
        const reengaged = h.server.threads.add(PROJECT, "reengaged", { settledOverride: "active" });
        const marker = h.settled("marker");
        // The settled thread's agent's server comes last, so once it is stopped the pass has
        // already passed over the others.
        h.server.ports.servers.push(
          listening(5101, { terminal: null, agent: { threadId: reengaged.shell.id } }),
          listening(5102, {
            terminal: { threadId: marker.shell.id, terminalId: "dev" },
            agent: null,
          }),
          listening(5103, { terminal: null, agent: { threadId: marker.shell.id } }),
        );
        yield* h.commit("thread.settled", reengaged);
        yield* h.commit("thread.settled", marker);
        yield* h.server.ports.stopped.taken(1);
        assert.deepStrictEqual(h.server.previews.closed.items, [marker.shell.id]);
        assert.deepStrictEqual(h.server.ports.stopped.items, [{ pid: 15_103, port: 5103 }]);

        const unarchived = h.server.threads.add(PROJECT, "unarchived", {});
        const archived = h.server.threads.add(PROJECT, "archived", { archivedAt: at(NOW) });
        yield* h.commit("thread.archived", unarchived);
        yield* h.commit("thread.archived", archived);
        yield* h.server.previews.closed.taken(2);
        assert.deepStrictEqual(h.server.previews.closed.items, [
          marker.shell.id,
          archived.shell.id,
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "settle a settled thread's subagents and side chats, not a plain fork, and un-settling it leaves them settled",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const parent = h.settled("parent");
        const subagent = (id: string, shell: Partial<OrchestrationV2ThreadShell> = {}) =>
          h.server.threads.add(PROJECT, id, {
            lineage: {
              parentThreadId: parent.shell.id,
              relationshipToParent: "subagent",
              rootThreadId: parent.shell.id,
            },
            ...shell,
          });
        const idle = subagent("idle-subagent");
        const alreadySettled = subagent("settled-subagent", {
          settledOverride: "settled",
          settledAt: at(NOW),
        });
        const archived = subagent("archived-subagent", { archivedAt: at(NOW) });
        const record = (childThreadId: ThreadId | null): OrchestrationV2Subagent => ({
          id: NodeId.make(`node:${childThreadId ?? "remote"}`),
          threadId: parent.shell.id,
          runId: null,
          parentNodeId: NodeId.make("node:parent"),
          origin: "provider_native",
          createdBy: "agent",
          driver: "codex" as OrchestrationV2Subagent["driver"],
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Review",
          title: "Review",
          model: null,
          status: "completed",
          result: null,
          startedAt: null,
          completedAt: null,
          updatedAt: at(NOW),
        });
        parent.subagents.push(
          record(idle.shell.id),
          record(alreadySettled.shell.id),
          record(archived.shell.id),
          record(null),
        );
        const fork = (
          id: string,
          sideChat: boolean,
          shell: Partial<OrchestrationV2ThreadShell> = {},
        ) => {
          const thread = h.server.threads.add(PROJECT, id, {
            lineage: {
              parentThreadId: parent.shell.id,
              relationshipToParent: "fork",
              rootThreadId: parent.shell.id,
              ...(sideChat ? { sideChat: true } : {}),
            },
            ...shell,
          });
          parent.contextTransfers.push({
            id: ContextTransferId.make(`transfer:${id}`),
            type: "fork",
            sourceThreadId: parent.shell.id,
            targetThreadId: thread.shell.id,
            sourcePoint: { threadId: parent.shell.id },
            basePoint: null,
            sourceProviderInstanceId: null,
            targetProviderInstanceId: null,
            targetRunId: null,
            status: "consumed",
            resolution: null,
            createdBy: "user",
            error: null,
            createdAt: at(NOW),
            updatedAt: at(NOW),
            consumedAt: at(NOW),
          } satisfies OrchestrationV2ContextTransfer);
          return thread;
        };
        const sideChat = fork("side-chat", true);
        fork("settled-side-chat", true, { settledOverride: "settled", settledAt: at(NOW) });
        fork("plain-fork", false);
        yield* h.commit("thread.settled", parent);
        yield* h.server.threads.settled(2);
        assert.deepStrictEqual(h.server.threads.settles, [idle.shell.id, sideChat.shell.id]);

        parent.shell = { ...parent.shell, settledOverride: "active", settledAt: null };
        yield* h.commit("thread.unsettled", parent);
        // The marker's reactions run after the un-settle's, so none has come of it.
        const marker = h.settled("marker");
        yield* h.commit("thread.settled", marker);
        yield* h.server.previews.closed.taken(2);
        assert.deepStrictEqual(h.server.threads.settles, [idle.shell.id, sideChat.shell.id]);
        assert.strictEqual(idle.shell.settledOverride, "settled");
        assert.strictEqual(sideChat.shell.settledOverride, "settled");
        // Nothing else was dispatched, which the fake would refuse.
        assert.deepStrictEqual(h.warnings, []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "remove a settled thread's monore copy, naming who else is on it, not a fenced link's or a deleted parent's",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const fs = yield* FileSystem.FileSystem;
        const root = `${h.server.tmp}/pult`;
        yield* h.server.projects.service.create({
          projectId: PROJECT,
          title: "pult",
          workspaceRoot: root,
          createWorkspaceRootIfMissing: true,
        });
        const copy = Effect.fn("copy")(function* (name: string) {
          const at = `${h.server.tmp}/.t3/worktrees/${name}`;
          yield* fs.makeDirectory(at, { recursive: true });
          yield* fs.writeFileString(`${at}/${MonoreVcsDriver.MONORE_MARKER}`, "");
          return at;
        });
        const linkCopy = yield* copy("link");
        const linked = h.settled("linked", {
          worktreePath: linkCopy,
          linkOrigin: { sessionId: "session-1", label: "MacBook", access: "read-only" },
        });
        const sharedCopy = yield* copy("shared");
        const parent = h.server.threads.add(PROJECT, "deleted-parent", {
          worktreePath: sharedCopy,
          deletedAt: at(NOW),
        });
        const child = h.settled("subagent", {
          worktreePath: sharedCopy,
          lineage: {
            parentThreadId: parent.shell.id,
            relationshipToParent: "subagent",
            rootThreadId: parent.shell.id,
          },
        });
        const ownCopy = yield* copy("own");
        const own = h.settled("own", { worktreePath: ownCopy });
        h.settled("also-settled", { worktreePath: ownCopy });
        const still = h.server.threads.add(PROJECT, "still-on-it", { worktreePath: ownCopy });
        yield* h.commit("thread.settled", linked);
        yield* h.commit("thread.settled", child);
        yield* h.commit("thread.settled", own);
        yield* h.server.copies.taken(1);
        assert.deepStrictEqual(h.server.copies.items, [
          { cwd: root, path: ownCopy, activeThreadIds: [still.shell.id] },
        ]);
        assert.deepStrictEqual(h.warnings, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "log a failing reaction, and the thread's next reaction and the next event still react",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const failing = h.settled("failing");
        const next = h.settled("next");
        h.server.previews.failFor.add(failing.shell.id);
        h.server.ports.servers.push(
          listening(5201, { terminal: null, agent: { threadId: failing.shell.id } }),
        );
        yield* h.commit("thread.settled", failing);
        yield* h.commit("thread.settled", next);
        yield* h.server.previews.closed.taken(1);
        assert.deepStrictEqual(h.server.previews.closed.items, [next.shell.id]);
        assert.deepStrictEqual(h.server.ports.stopped.items, [{ pid: 15_201, port: 5201 }]);
        assert.strictEqual(h.warnings.length, 1);
        assert.include(h.warnings[0], "a thread's settle reaction failed");
        assert.include(h.warnings[0], '"event":"thread.settled"');
        assert.include(h.warnings[0], `"threadId":"${failing.shell.id}"`);
        assert.include(h.warnings[0], '"reaction":"previews"');
      }).pipe(Effect.scoped),
  );
});
