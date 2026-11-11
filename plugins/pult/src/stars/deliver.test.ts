import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import { DispatchModeLimit, Effect, Exit, Layer } from "../host.ts";
import * as Delivery from "./deliver.ts";
import * as Stars from "./stars.ts";
import { at, fakeServer, run } from "./testing.ts";

const worker = ThreadId.make("worker");
const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;

/** One Star over a fake server, and `deliver` as the plugin builds it. */
const harness = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-11-10T13:00:00.000Z"));
  const server = yield* fakeServer;
  const stars = yield* Stars.make.pipe(Effect.provide(server.layer));
  const deliver = (yield* Delivery.make.pipe(Effect.provide(server.layer)))(stars);
  const star = yield* stars.create({ ifNone: true });
  /** The conversation that last ended, an hour ago. */
  const ended = () =>
    server.threads.add(star.projectId, "ended", {
      createdAt: at("2026-11-10T11:00:00.000Z"),
      settledOverride: "settled",
      settledAt: at("2026-11-10T12:00:00.000Z"),
      runtimeMode: "auto",
      interactionMode: "default",
    });
  /** An open conversation, its cache warm. */
  const open = (runs = [run("open-run", "completed")]) =>
    server.threads.add(
      star.projectId,
      "open",
      {
        createdAt: at("2026-11-10T12:50:00.000Z"),
        promptCacheExpiresAt: at("2026-11-10T13:30:00.000Z"),
        runtimeMode: "auto",
      },
      runs,
    );
  const fromPlugin = (key: string, text = "Hello") =>
    deliver({ star, text, from: 'schedule "standup"', key, sender: "plugin" });
  /** As a thread through `McpToolAccess.writesThreads`, which provides the caller's limits. */
  const fromThread = (
    key: string,
    limit: { runtimeMode: "auto" | "full-access"; interactionMode: "default" },
  ) =>
    deliver({ star, text: "Done.", from: "thread worker", key, sender: { thread: worker } }).pipe(
      Effect.provideService(DispatchModeLimit.DispatchModeLimit, limit),
    );
  return { ...server, star, deliver, ended, open, fromPlugin, fromThread };
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const failureCode = <A>(exit: Exit.Exit<A, { readonly code: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.code
    : undefined;

describe("deliver", () => {
  it.effect("wakes a sleeping Star at its last conversation's model and modes", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const last = h.ended();
      const delivered = yield* h.fromPlugin("k1", "Time for the standup.");
      assert.deepStrictEqual(delivered, {
        outcome: "launched",
        threadId: ThreadId.make("launched-1"),
      });
      const [launch] = h.launches.launches;
      assert.deepStrictEqual(
        {
          projectId: launch?.projectId,
          title: launch?.title,
          generateTitle: launch?.generateTitle,
          modelSelection: launch?.modelSelection,
          runtimeMode: launch?.runtimeMode,
          interactionMode: launch?.interactionMode,
          workspaceStrategy: launch?.workspaceStrategy,
        },
        {
          projectId: h.star.projectId,
          title: "Time for the standup.",
          generateTitle: true,
          modelSelection: last.shell.modelSelection,
          runtimeMode: "auto",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      );
      // From the plugin: a server message, no sender thread, no ceiling.
      const [message] = h.threads.messages;
      assert.deepStrictEqual(
        {
          threadId: message?.threadId,
          text: message?.text,
          senderThreadId: message?.senderThreadId,
          createdBy: message?.createdBy,
          creationSource: message?.creationSource,
        },
        {
          threadId: ThreadId.make("launched-1"),
          text: '[From schedule "standup"]\n\nTime for the standup.',
          senderThreadId: undefined,
          createdBy: "agent",
          creationSource: "server",
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("starts an idle conversation's turn and queues behind a running one", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      const open = h.open();
      assert.deepStrictEqual(yield* h.fromThread("k1", fullAccess), {
        outcome: "started",
        threadId: open.shell.id,
      });
      assert.deepStrictEqual(yield* h.fromThread("k2", fullAccess), {
        outcome: "queued",
        threadId: open.shell.id,
      });
      assert.strictEqual(h.launches.launches.length, 0);
      // From a thread: an MCP message naming its sender, sent under the caller's limits.
      const [message] = h.threads.messages;
      assert.deepStrictEqual(
        {
          text: message?.text,
          senderThreadId: message?.senderThreadId,
          createdBy: message?.createdBy,
          creationSource: message?.creationSource,
          limit: message?.limit,
        },
        {
          text: "[From thread worker]\n\nDone.",
          senderThreadId: worker,
          createdBy: "agent",
          creationSource: "mcp",
          limit: fullAccess,
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("wakes one thread for two concurrent messages to a sleeping Star", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      const both = yield* Effect.all([h.fromPlugin("k1"), h.fromPlugin("k2")], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(both.map((each) => each.outcome).toSorted(), ["launched", "queued"]);
      assert.strictEqual(h.launches.launches.length, 1);
      assert.deepStrictEqual(
        both.map((each) => each.threadId),
        [ThreadId.make("launched-1"), ThreadId.make("launched-1")],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("delivers a key once on either path, and finishes a wake cut short", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.ended();
      // The wake path, cut between the thread and its message, then finished, then replayed.
      h.launches.state.cutNext = true;
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromPlugin("wake"))),
        "orchestration_error",
      );
      assert.strictEqual(h.threads.messages.length, 0);
      assert.deepStrictEqual(yield* h.fromPlugin("wake"), {
        outcome: "launched",
        threadId: ThreadId.make("launched-1"),
      });
      assert.deepStrictEqual(yield* h.fromPlugin("wake"), {
        outcome: "replayed",
        threadId: ThreadId.make("launched-1"),
      });
      assert.strictEqual(h.threads.messages.length, 1);
      // The send path: the Star is awake now.
      assert.strictEqual((yield* h.fromPlugin("send")).outcome, "queued");
      assert.deepStrictEqual(yield* h.fromPlugin("send"), { outcome: "replayed", threadId: null });
      assert.strictEqual(h.threads.messages.length, 2);
      assert.strictEqual(h.launches.launches.length, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("holds a thread to modes no broader than its own, on either path", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const narrow = { runtimeMode: "auto", interactionMode: "default" } as const;
      const last = h.ended();
      last.shell = { ...last.shell, runtimeMode: "full-access" };
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromThread("k1", narrow))),
        "runtime_mode_escalation_denied",
      );
      assert.strictEqual(h.launches.launches.length, 0);
      const open = h.open();
      open.shell = { ...open.shell, runtimeMode: "full-access" };
      assert.strictEqual(
        failureCode(yield* Effect.exit(h.fromThread("k2", narrow))),
        "runtime_mode_escalation_denied",
      );
      assert.strictEqual(h.threads.messages.length, 0);
      // The plugin has no ceiling.
      assert.strictEqual((yield* h.fromPlugin("k3")).outcome, "started");
    }).pipe(Effect.scoped),
  );

  it.effect("fails for a Star never spoken to, and dies for a thread outside the wrapper", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      assert.strictEqual(failureCode(yield* Effect.exit(h.fromPlugin("k1"))), "thread_not_found");
      const outside = yield* Effect.exit(
        h.deliver({ star: h.star, text: "x", from: "y", key: "k2", sender: { thread: worker } }),
      );
      assert.isTrue(Exit.isFailure(outside) && outside.cause.reasons[0]?._tag === "Die");
    }).pipe(Effect.scoped),
  );
});
