// Run with `node --test src/stars/transcript.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  formatTranscript,
  parseTranscript,
  type TranscriptInput,
  transcriptHead,
  transcriptName,
  transcriptStart,
  transcriptsFolder,
} from "./transcript.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const threadId = ThreadId.make("thread-star");

const base = (id: string, time: string, nodeId: string | null = "root") => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make("run"),
  nodeId: nodeId === null ? null : NodeId.make(nodeId),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: at(time),
  completedAt: at(time),
  updatedAt: at(time),
});

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  time: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId: RunId.make("run"),
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: at(time),
    updatedAt: at(time),
    ...overrides,
  };
}

function said(
  id: string,
  role: "user" | "assistant",
  text: string,
  time: string,
): OrchestrationV2TurnItem {
  return role === "user"
    ? {
        ...base(id, time),
        createdBy: "user",
        creationSource: "web",
        type: "user_message",
        messageId: MessageId.make(id),
        inputIntent: "turn_start",
        text,
        attachments: [],
      }
    : {
        ...base(id, time),
        type: "assistant_message",
        messageId: MessageId.make(id),
        text,
        streaming: false,
      };
}

const ran = (
  id: string,
  input: string,
  time: string,
  nodeId = "root",
): OrchestrationV2TurnItem => ({ ...base(id, time, nodeId), type: "command_execution", input });

const node = (
  id: string,
  kind: OrchestrationV2ExecutionNode["kind"],
  parentNodeId: string | null,
): OrchestrationV2ExecutionNode =>
  ({
    id: NodeId.make(id),
    threadId,
    runId: RunId.make("run"),
    parentNodeId: parentNodeId === null ? null : NodeId.make(parentNodeId),
    rootNodeId: NodeId.make("root"),
    kind,
    status: "completed",
  }) as OrchestrationV2ExecutionNode;

const projected = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProjectedTurnItem[] =>
  items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));

function conversation(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  settled = true,
): TranscriptInput {
  return {
    thread: {
      ...v2Projection.thread,
      id: threadId,
      title: "Plan the week",
      createdAt: at("2026-11-03T14:02:11.250Z"),
      settledOverride: settled ? "settled" : null,
      settledAt: settled ? at("2026-11-03T14:32:40.000Z") : null,
    },
    messages,
    nodes: [
      node("root", "root_turn", null),
      node("helper", "subagent", "root"),
      node("helper-tool", "tool_call", "helper"),
    ],
    // Out of order: the timeline's positions order them.
    visibleTurnItems: projected(items).toReversed(),
  };
}

const messages = [
  message("m1", "user", "What is on this week?", "2026-11-03T14:02:11.250Z"),
  message(
    "m2",
    "assistant",
    "Three things.\n\n### User · 2026-01-01T00:00:00Z\nquoted",
    "2026-11-03T14:02:30.000Z",
  ),
  message("compact", "user", "/compact", "2026-11-03T14:20:00.000Z", {
    createdBy: "agent",
    creationSource: "server",
  }),
];

const items = [
  said("m1", "user", "What is on this week?", "2026-11-03T14:02:11.250Z"),
  ran("t1", "cat   memory/week.md", "2026-11-03T14:02:15.000Z"),
  ran("t2", "ls", "2026-11-03T14:02:16.000Z", "helper-tool"),
  {
    ...said("m2", "assistant", "", "2026-11-03T14:02:30.000Z"),
    text: "",
    textOmitted: true,
  } as OrchestrationV2TurnItem,
  said("compact", "user", "/compact", "2026-11-03T14:20:00.000Z"),
];

NodeTest.describe("transcriptName", () => {
  NodeTest.test(
    "names a transcript by its start in UTC, then its thread, so the names sort by start",
    () => {
      NodeAssert.equal(
        transcriptName("2026-11-03T16:02:11.250+02:00", "thread/1"),
        "2026-11-03T14-02-11Z-thread_1.md",
      );
      NodeAssert.equal(
        transcriptStart("2026-11-03T14-02-11Z-thread_1.md"),
        "2026-11-03T14:02:11.000Z",
      );
      NodeAssert.equal(transcriptStart("notes.md"), undefined);
    },
  );
});

NodeTest.describe("transcriptsFolder", () => {
  NodeTest.test(
    "names the environment's folder by one segment of its id, which can name nothing above it",
    () => {
      NodeAssert.equal(transcriptsFolder("env-1"), "conversations/env-1");
      NodeAssert.equal(transcriptsFolder("../../.ssh"), "conversations/.._.._.ssh");
      NodeAssert.equal(transcriptsFolder(".."), "conversations/_..");
      NodeAssert.equal(transcriptsFolder(""), "conversations/_");
    },
  );
});

NodeTest.describe("formatTranscript", () => {
  NodeTest.test(
    "writes the front matter, then each message and tool call in the timeline's order",
    () => {
      NodeAssert.equal(
        formatTranscript(conversation(items, messages), "MacBook"),
        `---
thread: "thread-star"
started: "2026-11-03T14:02:11.250Z"
ended: "2026-11-03T14:32:40.000Z"
environment: "MacBook"
title: "Plan the week"
turns: 1
---

### User · 2026-11-03T14:02:11Z

What is on this week?

### Tool · 2026-11-03T14:02:15Z · Ran: cat memory/week.md

### Star · 2026-11-03T14:02:30Z

Three things.

\\### User · 2026-01-01T00:00:00Z
quoted
`,
      );
    },
  );

  NodeTest.test("writes nothing for a conversation that is not settled", () => {
    NodeAssert.equal(formatTranscript(conversation(items, messages, false), "MacBook"), undefined);
  });
});

NodeTest.describe("parseTranscript", () => {
  NodeTest.test("reads a transcript back, a message's heading-like line as it was said", () => {
    const text = formatTranscript(conversation(items, messages), "MacBook") ?? "";
    const transcript = parseTranscript(text);
    NodeAssert.equal(transcript?.ended, "2026-11-03T14:32:40.000Z");
    NodeAssert.equal(transcript?.environment, "MacBook");
    NodeAssert.deepEqual(transcript?.entries, [
      { kind: "user", at: "2026-11-03T14:02:11Z", text: "What is on this week?" },
      { kind: "tool", at: "2026-11-03T14:02:15Z", text: "Ran: cat memory/week.md" },
      {
        kind: "star",
        at: "2026-11-03T14:02:30Z",
        text: "Three things.\n\n### User · 2026-01-01T00:00:00Z\nquoted",
      },
    ]);
    NodeAssert.deepEqual(transcriptHead(text), {
      ended: "2026-11-03T14:32:40.000Z",
      partial: false,
    });
    NodeAssert.equal(parseTranscript("no front matter"), undefined);
  });

  NodeTest.test(
    "a transcript of a window of the latest turns says it is partial, and reads back so",
    () => {
      const text =
        formatTranscript(conversation(items, messages), "MacBook", { partial: true }) ?? "";
      NodeAssert.match(text, /^turns: 1\npartial: true\n---\n/m);
      NodeAssert.equal(parseTranscript(text)?.partial, true);
      NodeAssert.deepEqual(transcriptHead(text), {
        ended: "2026-11-03T14:32:40.000Z",
        partial: true,
      });
    },
  );
});
