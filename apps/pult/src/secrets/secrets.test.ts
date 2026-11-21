// Run with `node --test src/secrets/secrets.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  v2Project,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { Star } from "../stars/stars.ts";
import { shellThreads } from "../threads/presentation.ts";
import { cardKey, pageSecrets } from "./secrets.ts";

const NOW = "2026-06-20T12:00:00.000Z";
const STAR_PROJECT = ProjectId.make("star");

/** A thread whose shell names a waiting card: one only the user answers, a secret's or a link's, unless `userOnly` is false, a question. */
const waiting = (
  id: string,
  card: string,
  at: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  userOnly = true,
) =>
  presentThreadShell(EnvironmentId.make("env"), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(card),
      kind: "user_input",
      createdAt: DateTime.makeUnsafe(at),
      ...(userOnly ? { userOnly: true } : {}),
    },
    ...overrides,
  });

const star: Star = {
  id: "beta",
  name: "Beta",
  tint: "",
  created: NOW,
  homes: [
    {
      environmentId: "env",
      directory: "/stars",
      root: "/stars/beta",
      projectId: STAR_PROJECT,
      instructions: "/stars/beta/instructions.md",
      channels: [],
      model: null,
      asleepSince: NOW,
      conversations: [],
      schedules: [],
    },
  ],
  channels: [],
  current: null,
  asleepSince: NOW,
  awakeOn: ["env"],
};

NodeTest.describe("pageSecrets", () => {
  NodeTest.test(
    "draws each waiting card read as a secret's, oldest first, whatever its thread's shelf, its poster a Star's channel or the thread",
    () => {
      const threads = shellThreads(
        [
          {
            environmentId: "env",
            threads: [
              waiting("plain", "secret-1", "2026-06-20T11:00:00.000Z", {
                settledOverride: "settled",
                settledAt: DateTime.makeUnsafe("2026-06-20T11:30:00.000Z"),
              }),
              waiting("channel", "secret-2", "2026-06-20T10:00:00.000Z", {
                projectId: STAR_PROJECT,
                tags: ["pult:channel:review"],
              }),
              waiting("linking", "link", "2026-06-20T09:00:00.000Z"),
              waiting("unread", "secret-3", "2026-06-20T09:00:00.000Z"),
              waiting("asking", "question", "2026-06-20T09:00:00.000Z", {}, false),
            ],
            projects: [v2Project, { ...v2Project, id: STAR_PROJECT }],
            features: { settlement: true, snooze: true, pinning: true },
            hidden: new Set([STAR_PROJECT]),
          },
        ],
        NOW,
      );
      const read = (threadId: string, id: string, type: string, label: string) =>
        [cardKey({ environmentId: "env", threadId, id }), { type, label }] as const;
      const reads = new Map([
        read("plain", "secret-1", "secret_request", "OpenAI API key"),
        read("channel", "secret-2", "secret_request", "GitHub token"),
        read("linking", "link", "link_request", ""),
        read("asking", "question", "secret_request", "Never asked"),
      ]);
      NodeAssert.deepEqual(pageSecrets(threads, reads, [star]), [
        {
          environmentId: "env",
          threadId: "channel",
          id: "secret-2",
          since: "2026-06-20T10:00:00.000Z",
          label: "GitHub token",
          poster: { star: "beta", channel: "review" },
        },
        {
          environmentId: "env",
          threadId: "plain",
          id: "secret-1",
          since: "2026-06-20T11:00:00.000Z",
          label: "OpenAI API key",
          poster: { thread: "plain" },
        },
      ]);
    },
  );
});
