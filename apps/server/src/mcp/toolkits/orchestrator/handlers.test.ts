import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const callerId = ThreadId.make("thread:caller");
const peerId = ThreadId.make("thread:peer");
const broaderId = ThreadId.make("thread:broader");

/** A thread at `auto` may write threads up to `auto`, so not one at `full-access`. */
const harness = () => {
  const modes: Record<string, RuntimeMode> = {
    [callerId]: "auto",
    [peerId]: "auto",
    [broaderId]: "full-access",
  };
  const tags = new Map<ThreadId, ReadonlyArray<string>>();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const shell = (threadId: ThreadId) => ({
    ...liveThreadShell(threadId, { runtimeMode: modes[threadId] ?? "full-access" }),
    tags: tags.get(threadId) ?? [],
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: `provider:${callerId}`,
      thread: {
        threadId: callerId,
        providerSessionId: `provider:${callerId}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    ThreadMetadataMcpService.layer.pipe(
      Layer.provideMerge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shell(threadId)),
          dispatch: (command) => {
            dispatched.push(command);
            if (command.type === "thread.tag.set") {
              const current = tags.get(command.threadId) ?? [];
              tags.set(
                command.threadId,
                command.tagged
                  ? [...current.filter((tag) => tag !== command.tag), command.tag]
                  : current.filter((tag) => tag !== command.tag),
              );
            }
            // No stored events, so the service answers from the thread as it now is.
            return Effect.succeed({
              sequence: dispatched.length,
              storedEvents: [],
            } satisfies Orchestrator.OrchestratorV2DispatchResult);
          },
        }),
      ),
      Layer.provide(NodeCrypto.layer),
    ),
  );
  const update = (args: Record<string, unknown>) =>
    OrchestratorToolkit.pipe(
      Effect.flatMap((toolkit) =>
        toolkit.handle("t3_thread_update", args as never).pipe(Stream.unwrap, Stream.runCollect),
      ),
      Effect.map((results) => results.at(-1)?.result),
      Effect.provide(
        Layer.provideMerge(
          McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer),
          dependencies,
        ),
      ),
    );
  return { update, dispatched };
};

// Pult: a Star's child launched without its channel's tag is fixed in one call.
it.effect(
  "t3_thread_update sets and removes a tag on the caller's thread and one it may write",
  () =>
    Effect.gen(function* () {
      const { update, dispatched } = harness();

      expect(
        yield* update({ action: "tag", tag: "pult:channel:work", tagged: true }),
      ).toMatchObject({
        threadId: callerId,
        action: "tag",
        tags: ["pult:channel:work"],
      });
      expect(
        yield* update({ action: "tag", tag: "pult:channel:work", tagged: false }),
      ).toMatchObject({ threadId: callerId, tags: [] });

      expect(
        yield* update({ threadId: peerId, action: "tag", tag: "pult:channel:work", tagged: true }),
      ).toMatchObject({ threadId: peerId, tags: ["pult:channel:work"] });
      expect(
        yield* update({ threadId: peerId, action: "tag", tag: "pult:channel:work", tagged: false }),
      ).toMatchObject({ threadId: peerId, tags: [] });

      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.tag.set",
        "thread.tag.set",
        "thread.tag.set",
        "thread.tag.set",
      ]);
      expect(dispatched[1]).toMatchObject({
        threadId: callerId,
        tag: "pult:channel:work",
        tagged: false,
      });
    }),
);

it.effect("t3_thread_update refuses a tag on a thread above the caller's modes", () =>
  Effect.gen(function* () {
    const { update, dispatched } = harness();
    expect(
      yield* update({ threadId: broaderId, action: "tag", tag: "pult:channel:work", tagged: true }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(dispatched).toEqual([]);
  }),
);

it.effect("t3_thread_update still renames and regenerates titles", () =>
  Effect.gen(function* () {
    const { update, dispatched } = harness();
    expect(yield* update({ threadId: peerId, action: "rename", title: "Renamed" })).toMatchObject({
      threadId: peerId,
      action: "rename",
    });
    expect(yield* update({ action: "regenerate_title" })).toMatchObject({
      threadId: callerId,
      action: "regenerate_title",
    });
    expect(dispatched).toMatchObject([
      { type: "thread.metadata.update", threadId: peerId, title: "Renamed" },
      { type: "thread.metadata.update", threadId: callerId, regenerateTitle: true },
    ]);
    expect(
      yield* update({ threadId: broaderId, action: "rename", title: "Renamed" }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
  }),
);
