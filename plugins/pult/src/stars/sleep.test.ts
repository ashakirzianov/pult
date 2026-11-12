import { assert, describe, it } from "@effect/vitest";

import {
  MessageId,
  NodeId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";

import { DateTime } from "../host.ts";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  asleepBy,
  contextFull,
  DEFAULT_CACHE_TTL_MS,
  type SleepInput,
  wakefulness,
} from "./sleep.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const ms = (iso: string) => Date.parse(iso);

function run(
  id: string,
  status: OrchestrationV2Run["status"],
  completedAt: string | null = null,
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: at("2026-11-03T10:00:00.000Z"),
    startedAt: at("2026-11-03T10:00:01.000Z"),
    completedAt: completedAt === null ? null : at(completedAt),
    checkpointId: null,
    contextHandoffId: null,
  };
}

function turn(
  id: string,
  completedAt: string | null,
  options: {
    status?: OrchestrationV2ProviderTurn["status"];
    ttl?: number;
    providerThread?: string;
    usage?: { readonly usedTokens: number; readonly maxTokens?: number | null };
  } = {},
): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(id),
    providerThreadId: ProviderThreadId.make(options.providerThread ?? "provider-thread"),
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: options.status ?? (completedAt === null ? "running" : "completed"),
    startedAt: at("2026-11-03T10:00:00.000Z"),
    completedAt: completedAt === null ? null : at(completedAt),
    ...(options.ttl === undefined && options.usage === undefined
      ? {}
      : {
          tokenUsage: {
            usedTokens: 1000,
            ...options.usage,
            ...(options.ttl === undefined ? {} : { promptCacheTtlMs: options.ttl }),
            updatedAt: completedAt ?? "2026-11-03T10:00:00.000Z",
          },
        }),
  };
}

function request(status: OrchestrationV2RuntimeRequest["status"]): OrchestrationV2RuntimeRequest {
  return {
    id: RuntimeRequestId.make("request"),
    nodeId: NodeId.make("node-request"),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status,
    responseCapability: { type: "message" },
    createdAt: at("2026-11-03T10:05:00.000Z"),
    resolvedAt: null,
  };
}

function subagent(status: OrchestrationV2Subagent["status"]): OrchestrationV2Subagent {
  return {
    id: NodeId.make("node-subagent"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: NodeId.make("node-parent"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Look it up",
    title: null,
    model: null,
    status,
    result: null,
    startedAt: at("2026-11-03T10:09:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-11-03T10:09:00.000Z"),
  };
}

const conversation = (overrides: Partial<SleepInput>): SleepInput => ({
  ...v2Projection,
  ...overrides,
});

describe("wakefulness", () => {
  it("falls asleep when the prompt cache expires, as the server says", () => {
    const state = wakefulness(
      conversation({
        runs: [run("one", "completed", "2026-11-03T10:10:00.000Z")],
        providerTurns: [turn("last", "2026-11-03T10:10:00.000Z", { ttl: 300_000 })],
      }),
      at("2026-11-03T10:40:00.000Z"),
    );
    assert.deepStrictEqual(state, { kind: "deadline", at: ms("2026-11-03T10:40:00.000Z") });
  });

  it("keeps a conversation un-settled after its cache expires awake 10 minutes from then", () => {
    const expiresAt = "2026-11-03T10:40:00.000Z";
    const woken = { ...v2Projection.thread, unsettledAt: at("2026-11-03T12:00:00.000Z") };
    assert.deepStrictEqual(wakefulness(conversation({ thread: woken }), at(expiresAt)), {
      kind: "deadline",
      at: ms("2026-11-03T12:00:00.000Z") + DEFAULT_CACHE_TTL_MS,
    });
    const earlier = { ...v2Projection.thread, unsettledAt: at("2026-11-03T10:20:00.000Z") };
    assert.deepStrictEqual(wakefulness(conversation({ thread: earlier }), at(expiresAt)), {
      kind: "deadline",
      at: ms(expiresAt),
    });
  });

  it("still holds the conversation awake whatever the server's expiry", () => {
    assert.deepStrictEqual(
      wakefulness(conversation({ runs: [run("live", "running")] }), at("2026-11-03T10:40:00.000Z")),
      { kind: "held", by: "run" },
    );
  });

  it("keeps the turns' rule where the server serves no expiry, an older one or none known", () => {
    const input = conversation({
      providerTurns: [turn("last", "2026-11-03T10:10:00.000Z", { ttl: 300_000 })],
    });
    const byTurns = { kind: "deadline" as const, at: ms("2026-11-03T10:15:00.000Z") };
    assert.deepStrictEqual(wakefulness(input, undefined), byTurns);
    assert.deepStrictEqual(wakefulness(input, null), byTurns);
  });

  it("falls asleep at the last turn's end plus the cache TTL its adapter observed", () => {
    const state = wakefulness(
      conversation({
        runs: [run("one", "completed", "2026-11-03T10:10:00.000Z")],
        providerTurns: [
          turn("early", "2026-11-03T10:02:00.000Z", { ttl: 3_600_000 }),
          turn("last", "2026-11-03T10:10:00.000Z", { ttl: 300_000 }),
        ],
      }),
    );
    assert.deepStrictEqual(state, { kind: "deadline", at: ms("2026-11-03T10:15:00.000Z") });
  });

  it("takes the TTL observed earlier on the same provider thread when the last turn reported none", () => {
    const state = wakefulness(
      conversation({
        providerTurns: [
          turn("early", "2026-11-03T10:02:00.000Z", { ttl: 3_600_000 }),
          turn("elsewhere", "2026-11-03T10:05:00.000Z", {
            ttl: 300_000,
            providerThread: "other",
          }),
          turn("cached", "2026-11-03T10:10:00.000Z"),
        ],
      }),
    );
    assert.deepStrictEqual(state, { kind: "deadline", at: ms("2026-11-03T11:10:00.000Z") });
  });

  it("allows 10 minutes where no TTL was observed", () => {
    const state = wakefulness(
      conversation({ providerTurns: [turn("codex", "2026-11-03T10:10:00.000Z")] }),
    );
    assert.deepStrictEqual(state, {
      kind: "deadline",
      at: ms("2026-11-03T10:10:00.000Z") + DEFAULT_CACHE_TTL_MS,
    });
  });

  it("falls back to the latest finished run, then to the thread's creation", () => {
    assert.deepStrictEqual(
      wakefulness(conversation({ runs: [run("failed", "failed", "2026-11-03T10:20:00.000Z")] })),
      {
        kind: "deadline",
        at: ms("2026-11-03T10:20:00.000Z") + DEFAULT_CACHE_TTL_MS,
      },
    );
    assert.deepStrictEqual(wakefulness(conversation({})), {
      kind: "deadline",
      at: DateTime.toEpochMillis(v2Projection.thread.createdAt) + DEFAULT_CACHE_TTL_MS,
    });
  });

  it("holds the conversation awake while a run is on, a message is queued or a request awaits the user", () => {
    const done = turn("done", "2026-11-03T10:10:00.000Z");
    assert.deepStrictEqual(
      wakefulness(conversation({ runs: [run("live", "running")], providerTurns: [done] })),
      { kind: "held", by: "run" },
    );
    assert.deepStrictEqual(
      wakefulness(conversation({ runs: [run("draining", "waiting")], providerTurns: [done] })),
      { kind: "held", by: "run" },
    );
    assert.deepStrictEqual(
      wakefulness(
        conversation({
          runs: [
            run("done", "completed", "2026-11-03T10:10:00.000Z"),
            { ...run("next", "queued"), queueHeld: true },
          ],
          providerTurns: [done],
        }),
      ),
      {
        kind: "held",
        by: "queued",
      },
    );
    assert.deepStrictEqual(
      wakefulness(conversation({ providerTurns: [done], runtimeRequests: [request("pending")] })),
      { kind: "held", by: "request" },
    );
    assert.strictEqual(
      wakefulness(conversation({ providerTurns: [done], runtimeRequests: [request("resolved")] }))
        .kind,
      "deadline",
    );
  });

  it("holds the conversation awake while a subagent of it works, and not once it is done", () => {
    const done = turn("done", "2026-11-03T10:10:00.000Z");
    for (const status of ["pending", "running", "waiting"] as const) {
      assert.deepStrictEqual(
        wakefulness(conversation({ providerTurns: [done], subagents: [subagent(status)] })),
        { kind: "held", by: "subagent" },
      );
    }
    assert.deepStrictEqual(
      wakefulness(conversation({ providerTurns: [done], subagents: [subagent("completed")] })),
      {
        kind: "deadline",
        at: ms("2026-11-03T10:10:00.000Z") + DEFAULT_CACHE_TTL_MS,
      },
    );
  });

  it("a provider turn left running after its run ended holds nothing", () => {
    const state = wakefulness(
      conversation({
        runs: [run("ended", "completed", "2026-11-03T10:10:00.000Z")],
        providerTurns: [turn("done", "2026-11-03T10:10:00.000Z"), turn("stuck", null)],
      }),
    );
    assert.deepStrictEqual(state, {
      kind: "deadline",
      at: ms("2026-11-03T10:10:00.000Z") + DEFAULT_CACHE_TTL_MS,
    });
  });

  it("counts from the un-settlement when the conversation was woken by hand after its last turn", () => {
    const providerTurns = [turn("done", "2026-11-03T10:10:00.000Z", { ttl: 300_000 })];
    const woken = { ...v2Projection.thread, unsettledAt: at("2026-11-03T12:00:00.000Z") };
    assert.deepStrictEqual(wakefulness(conversation({ thread: woken, providerTurns })), {
      kind: "deadline",
      at: ms("2026-11-03T12:05:00.000Z"),
    });
    assert.deepStrictEqual(wakefulness(conversation({ thread: woken })), {
      kind: "deadline",
      at: ms("2026-11-03T12:00:00.000Z") + DEFAULT_CACHE_TTL_MS,
    });
    // An un-settlement before the last turn changes nothing.
    const earlier = { ...v2Projection.thread, unsettledAt: at("2026-11-03T10:00:00.000Z") };
    assert.deepStrictEqual(wakefulness(conversation({ thread: earlier, providerTurns })), {
      kind: "deadline",
      at: ms("2026-11-03T10:15:00.000Z"),
    });
  });
});

describe("a full context", () => {
  const ended = "2026-11-03T10:10:00.000Z";
  const full = (usage: { usedTokens: number; maxTokens?: number | null }) =>
    contextFull([turn("last", ended, { usage })]);

  it("is 250,000 tokens in context, or 75% of the window, whichever comes first", () => {
    assert.strictEqual(full({ usedTokens: 249_999, maxTokens: 1_000_000 }), false);
    assert.strictEqual(full({ usedTokens: 250_000, maxTokens: 1_000_000 }), true);
    assert.strictEqual(full({ usedTokens: 250_000 }), true);
    assert.strictEqual(full({ usedTokens: 149_999, maxTokens: 200_000 }), false);
    assert.strictEqual(full({ usedTokens: 150_000, maxTokens: 200_000 }), true);
  });

  it("is not where no turn reported usage, and by tokens alone where the window is unknown", () => {
    assert.strictEqual(contextFull([]), false);
    assert.strictEqual(contextFull([turn("bare", ended)]), false);
    assert.strictEqual(full({ usedTokens: 200_000, maxTokens: null }), false);
    assert.strictEqual(full({ usedTokens: 200_000, maxTokens: 0 }), false);
  });

  it("reads the newest usage reported, as the context meter does", () => {
    const heavy = turn("heavy", "2026-11-03T10:05:00.000Z", { usage: { usedTokens: 300_000 } });
    const compacted = turn("compacted", ended, { usage: { usedTokens: 20_000 } });
    assert.strictEqual(contextFull([heavy, compacted]), false);
    assert.strictEqual(contextFull([compacted, heavy]), false);
    assert.strictEqual(contextFull([heavy, turn("bare", ended)]), true);
  });

  it("takes the deadline as passed for a conversation that rotates on it, every hold applying", () => {
    const providerTurns = [turn("last", ended, { ttl: 3_600_000, usage: { usedTokens: 260_000 } })];
    const expiresAt = at("2026-11-03T11:10:00.000Z");
    const input = conversation({ providerTurns });
    assert.deepStrictEqual(wakefulness(input, expiresAt, { rotatesWhenFull: true }), {
      kind: "deadline",
      at: ms(ended),
    });
    assert.deepStrictEqual(wakefulness(input, null, { rotatesWhenFull: true }), {
      kind: "deadline",
      at: ms(ended),
    });
    // The conversation with the user never rotates on it.
    assert.deepStrictEqual(wakefulness(input, expiresAt), {
      kind: "deadline",
      at: ms("2026-11-03T11:10:00.000Z"),
    });
    assert.deepStrictEqual(
      wakefulness(
        conversation({
          providerTurns,
          runs: [run("done", "completed", ended), { ...run("next", "queued"), queueHeld: true }],
        }),
        expiresAt,
        { rotatesWhenFull: true },
      ),
      { kind: "held", by: "queued" },
    );
  });
});

describe("asleepBy", () => {
  it("is asleep from the deadline on, and never while held", () => {
    const deadline = { kind: "deadline", at: 1_000 } as const;
    assert.strictEqual(asleepBy(deadline, 999), false);
    assert.strictEqual(asleepBy(deadline, 1_000), true);
    assert.strictEqual(asleepBy({ kind: "held", by: "run" }, Number.MAX_SAFE_INTEGER), false);
  });
});
