// Run with `node --test src/stars/history.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { decodeThreadSnapshot, threadSnapshotUrl } from "./history.ts";
import { formatTranscript, parseTranscript } from "./transcript.ts";

const { thread } = v2Projection;

/** A settled conversation of `count` exchanges, more than the socket's window of ten user turns holds. */
function longConversation(count: number): OrchestrationV2ThreadProjection {
  const messages: OrchestrationV2ConversationMessage[] = [];
  const items: OrchestrationV2TurnItem[] = [];
  for (let turn = 0; turn < count; turn++) {
    for (const role of ["user", "assistant"] as const) {
      const id = `${role}-${turn}`;
      const time = DateTime.makeUnsafe(Date.UTC(2026, 10, 3, 10, turn, role === "user" ? 0 : 30));
      const shared = {
        id: TurnItemId.make(id),
        threadId: thread.id,
        runId: RunId.make(`run-${turn}`),
        nodeId: NodeId.make("root"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: time,
        completedAt: time,
        updatedAt: time,
      };
      const text = `${role === "user" ? "Question" : "Answer"} ${turn}`;
      messages.push({
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "web",
        id: MessageId.make(id),
        threadId: thread.id,
        runId: RunId.make(`run-${turn}`),
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: time,
        updatedAt: time,
      });
      items.push(
        role === "user"
          ? {
              ...shared,
              createdBy: "user",
              creationSource: "web",
              type: "user_message",
              messageId: MessageId.make(id),
              inputIntent: "turn_start",
              text,
              attachments: [],
            }
          : {
              ...shared,
              type: "assistant_message",
              messageId: MessageId.make(id),
              text,
              streaming: false,
            },
      );
    }
  }
  return {
    ...v2Projection,
    thread: {
      ...thread,
      settledOverride: "settled",
      settledAt: DateTime.makeUnsafe("2026-11-03T11:00:00.000Z"),
    },
    messages,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item.id,
      item,
    })),
  };
}

NodeTest.describe("decodeThreadSnapshot", () => {
  NodeTest.test(
    "reads the whole projection as the server's HTTP API sends it, every turn into the transcript",
    () => {
      const wire = JSON.parse(
        JSON.stringify(
          Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot))({
            snapshotSequence: 7,
            projection: longConversation(14),
          }),
        ),
      );
      const transcript = parseTranscript(
        formatTranscript(decodeThreadSnapshot(wire).projection, "MacBook") ?? "",
      );
      NodeAssert.equal(transcript?.partial, false);
      NodeAssert.equal(transcript?.entries.length, 28);
      NodeAssert.deepEqual(transcript?.entries[0], {
        kind: "user",
        at: "2026-11-03T10:00:00Z",
        text: "Question 0",
      });
      NodeAssert.match(
        formatTranscript(decodeThreadSnapshot(wire).projection, "MacBook") ?? "",
        /^turns: 14$/m,
      );
    },
  );
});

NodeTest.describe("threadSnapshotUrl", () => {
  NodeTest.test("keeps the base URL's path", () => {
    NodeAssert.equal(
      threadSnapshotUrl("https://host:3773", "t/1").href,
      "https://host:3773/api/orchestration/threads/t%2F1",
    );
    NodeAssert.equal(
      threadSnapshotUrl("https://relay.example/env/abc/", "t1").href,
      "https://relay.example/env/abc/api/orchestration/threads/t1",
    );
  });
});
