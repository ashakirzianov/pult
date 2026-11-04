// Run with `node --test src/files/projects.test.ts`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { endedTurns, projectRoots } from "./projects.ts";

const pult = { id: "p-pult" as ProjectId, title: "pult", workspaceRoot: "/repos/pult" };
const axis = { id: "p-axis" as ProjectId, title: "axis", workspaceRoot: "/repos/axis" };
const at = (millis: number) => DateTime.makeUnsafe(millis);

function thread(
  id: string,
  fields: Partial<{
    projectId: ProjectId;
    worktreePath: string | null;
    branch: string | null;
    deletedAt: DateTime.Utc | null;
    updatedAt: DateTime.Utc;
    latestRunCompletedAt: DateTime.Utc | null;
  }>,
) {
  return {
    id: id as ThreadId,
    projectId: pult.id,
    worktreePath: null,
    branch: null,
    deletedAt: null,
    updatedAt: at(0),
    latestRunCompletedAt: null,
    ...fields,
  };
}

describe("projectRoots", () => {
  it("lists each project's root, then the worktrees its live threads run in", () => {
    const roots = projectRoots({
      projects: [pult, axis],
      threads: [
        thread("t1", { worktreePath: "/wt/vfs", branch: "virtual-workspace", updatedAt: at(1) }),
        thread("t2", { worktreePath: "/wt/tabs", branch: "thread-tabs", updatedAt: at(3) }),
        thread("t3", { worktreePath: "/wt/vfs", branch: "older", updatedAt: at(0) }),
        thread("t4", { worktreePath: "/wt/gone", deletedAt: at(2) }),
        thread("t5", { worktreePath: "/wt/nobranch", updatedAt: at(2) }),
      ],
    });
    assert.deepEqual(roots.map((root) => [root.path, root.name]), [
      ["/repos/axis", "axis"],
      ["/repos/pult", "pult"],
      ["/wt/tabs", "pult · thread-tabs"],
      ["/wt/nobranch", "pult · nobranch"],
      ["/wt/vfs", "pult · virtual-workspace"],
    ]);
  });
});

describe("endedTurns", () => {
  it("reports nothing for threads first seen, then the roots of runs that completed", () => {
    const shell = (threads: ReadonlyArray<ReturnType<typeof thread>>) => ({
      projects: [pult],
      threads,
    });
    const first = endedTurns(
      new Map(),
      shell([
        thread("t1", { latestRunCompletedAt: at(10) }),
        thread("t2", { worktreePath: "/wt/vfs" }),
      ]),
    );
    assert.deepEqual(first.roots, new Set());

    const next = endedTurns(
      first.seen,
      shell([
        thread("t1", { latestRunCompletedAt: at(10) }),
        thread("t2", { worktreePath: "/wt/vfs", latestRunCompletedAt: at(20) }),
      ]),
    );
    assert.deepEqual(next.roots, new Set(["/wt/vfs"]));

    const later = endedTurns(next.seen, shell([thread("t1", { latestRunCompletedAt: at(30) })]));
    assert.deepEqual(later.roots, new Set(["/repos/pult"]));
  });
});
