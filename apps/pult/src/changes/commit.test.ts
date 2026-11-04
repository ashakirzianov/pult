// Run with `node --test src/changes/commit.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { GitActionProgressEvent } from "@t3tools/contracts";

import { COMMIT_STARTED, commitFailure, commitProgress } from "./commit.ts";

const base = { actionId: "a", cwd: "/repo", action: "commit" } as const;
const follow = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.reduce(
    (progress, event) => commitProgress(progress, { ...base, ...event } as GitActionProgressEvent),
    COMMIT_STARTED,
  );

NodeTest.describe("commitProgress", () => {
  NodeTest.test("reads the server's phase, a hook while it runs, then the phase again", () => {
    const generating = follow([
      { kind: "action_started", phases: ["commit"] },
      { kind: "phase_started", phase: "commit", label: "Generating commit message..." },
    ]);
    NodeAssert.equal(generating.label, "Generating commit message…");
    const hook = commitProgress(generating, {
      ...base,
      kind: "hook_started",
      hookName: "pre-commit",
    });
    NodeAssert.equal(hook.label, "Running pre-commit…");
    const after = commitProgress(hook, {
      ...base,
      kind: "hook_finished",
      hookName: "pre-commit",
      exitCode: 0,
      durationMs: 10,
    });
    NodeAssert.equal(after.label, "Generating commit message…");
  });
});

NodeTest.describe("commitFailure", () => {
  NodeTest.test("the server's message, then a failed hook's last line", () => {
    const progress = follow([
      { kind: "phase_started", phase: "commit", label: "Committing..." },
      { kind: "hook_started", hookName: "pre-commit" },
      { kind: "hook_output", hookName: "pre-commit", stream: "stderr", text: "lint: 2 errors" },
      { kind: "hook_finished", hookName: "pre-commit", exitCode: 1, durationMs: 10 },
      { kind: "action_failed", phase: "commit", message: "Git commit failed." },
    ]);
    NodeAssert.equal(
      commitFailure(progress, new Error("Source control action failed.")),
      "Git commit failed. lint: 2 errors",
    );
  });

  NodeTest.test(
    "the stream's error without one, and a line the message holds already left out",
    () => {
      const progress = follow([
        { kind: "hook_output", hookName: null, stream: "stderr", text: "fatal: no identity" },
      ]);
      NodeAssert.equal(
        commitFailure(progress, new Error("commit: fatal: no identity")),
        "commit: fatal: no identity",
      );
      NodeAssert.equal(
        commitFailure(COMMIT_STARTED, new Error("Socket closed.")),
        "Socket closed.",
      );
    },
  );
});
