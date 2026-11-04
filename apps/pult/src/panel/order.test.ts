// Run with `node --test src/panel/order.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ShelfName } from "../threads/store.ts";
import { draftCards, jumpTargets, type PanelRows } from "./order.ts";

const file = (environmentId: string, path: string) => ({
  scheme: "pult",
  authority: environmentId,
  path,
  toString: () => `pult://${environmentId}${path}`,
});
const thread = (id: string, shelf: ShelfName | null, environmentId = "env") => ({
  environmentId,
  id,
  shelf,
});
const draft = (projectId: string, environmentId = "env") => ({
  environmentId,
  projectId,
  preview: "Fix it",
  createdAt: "2026-11-02T00:00:00.000Z",
});

const EXPANDED = { ready: true, working: true, snoozed: true, settled: true };
const COLLAPSED = { ready: false, working: false, snoozed: false, settled: false };

function panel(
  overrides: Partial<PanelRows<ReturnType<typeof file>, ReturnType<typeof thread>>> = {},
) {
  return {
    stars: [],
    environmentIds: ["env"],
    explorer: { files: [], highlighted: undefined, expanded: true },
    drafts: [],
    threads: [],
    selection: undefined,
    expanded: EXPANDED,
    settledCount: 10,
    settledShown: true,
    ...overrides,
  };
}

const keys = (targets: ReadonlyArray<{ readonly key: string }>) =>
  targets.map((target) => target.key);

NodeTest.describe("jumpTargets", () => {
  NodeTest.test(
    "reaches the Explorer's files, then the drafts, then the threads shelf by shelf, as the panel lists them",
    () => {
      const targets = jumpTargets(
        panel({
          environmentIds: ["env", "other"],
          explorer: {
            files: [file("other", "/b.ts"), file("env", "/a.ts")],
            highlighted: undefined,
            expanded: true,
          },
          drafts: [draft("project")],
          threads: [
            thread("settled", "settled"),
            thread("pinned", "pinned"),
            thread("snoozed", "snoozed"),
            thread("active", "active"),
            thread("working", "working"),
            thread("subagent", null),
          ],
        }),
      );
      NodeAssert.deepEqual(keys(targets), [
        "pult://env/a.ts",
        "pult://other/b.ts",
        "draft:env/project",
        "env/pinned",
        "env/active",
        "env/working",
        "env/snoozed",
        "env/settled",
      ]);
    },
  );

  NodeTest.test(
    "reaches the Stars' cards first, above the Explorer's files, whatever the shelves",
    () => {
      const targets = jumpTargets(
        panel({
          stars: ["one"],
          explorer: { files: [file("env", "/a.ts")], highlighted: undefined, expanded: true },
          threads: [thread("active", "active")],
          expanded: COLLAPSED,
          selection: "env/active",
        }),
      );
      NodeAssert.deepEqual(keys(targets), ["star:one", "pult://env/a.ts", "env/active"]);
    },
  );

  NodeTest.test("reaches a collapsed list's selected row alone", () => {
    const threads = [
      thread("one", "active"),
      thread("two", "active"),
      thread("old", "settled"),
      thread("older", "settled"),
    ];
    NodeAssert.deepEqual(
      keys(jumpTargets(panel({ threads, expanded: COLLAPSED, selection: "env/two" }))),
      ["env/two"],
    );
    NodeAssert.deepEqual(
      keys(jumpTargets(panel({ threads, expanded: COLLAPSED, selection: "env/older" }))),
      ["env/older"],
    );
    const files = [file("env", "/a.ts"), file("env", "/b.ts")];
    NodeAssert.deepEqual(
      keys(
        jumpTargets(
          panel({
            explorer: { files, highlighted: "pult://env/b.ts", expanded: false },
            expanded: COLLAPSED,
          }),
        ),
      ),
      ["pult://env/b.ts"],
    );
    NodeAssert.deepEqual(
      keys(
        jumpTargets(
          panel({
            explorer: { files, highlighted: "environment:env", expanded: false },
            expanded: COLLAPSED,
          }),
        ),
      ),
      [],
    );
  });

  NodeTest.test(
    "reaches no settled thread while the Settled shelf is hidden, not even the selected one",
    () => {
      const threads = [thread("active", "active"), thread("old", "settled")];
      NodeAssert.deepEqual(
        keys(jumpTargets(panel({ threads, settledShown: false, selection: "env/old" }))),
        ["env/active"],
      );
      NodeAssert.deepEqual(
        keys(
          jumpTargets(
            panel({ threads, settledShown: false, expanded: COLLAPSED, selection: "env/old" }),
          ),
        ),
        [],
      );
    },
  );

  NodeTest.test("reaches the settled tail's shown threads, and the selected one beyond it", () => {
    const threads = ["a", "b", "c", "d"].map((id) => thread(id, "settled"));
    NodeAssert.deepEqual(keys(jumpTargets(panel({ threads, settledCount: 2 }))), [
      "env/a",
      "env/b",
    ]);
    NodeAssert.deepEqual(
      keys(jumpTargets(panel({ threads, settledCount: 2, selection: "env/d" }))),
      ["env/a", "env/b", "env/d"],
    );
  });

  NodeTest.test("reaches the Explorer's files alone while no environment is held", () => {
    const targets = jumpTargets(
      panel({
        environmentIds: [],
        explorer: { files: [file("gone", "/a.ts")], highlighted: undefined, expanded: true },
        threads: [thread("one", "active")],
      }),
    );
    NodeAssert.deepEqual(keys(targets), ["pult://gone/a.ts"]);
  });
});

NodeTest.describe("draftCards", () => {
  NodeTest.test(
    "puts the selected draft first while it is empty, and leaves out drafts of environments not held",
    () => {
      const drafts = [draft("full"), draft("elsewhere", "gone")];
      const projects = (selected: string) =>
        draftCards(drafts, { environmentId: "env", projectId: selected }, new Set(["env"])).map(
          (each) => each.projectId,
        );
      NodeAssert.deepEqual(projects("empty"), ["empty", "full"]);
      NodeAssert.deepEqual(projects("full"), ["full"]);
    },
  );

  NodeTest.test("leaves out a Star's draft", () => {
    const drafts = [draft("full"), draft("star")];
    const cards = draftCards(
      drafts,
      undefined,
      new Set(["env"]),
      (each) => each.projectId === "star",
    );
    NodeAssert.deepEqual(
      cards.map((each) => each.projectId),
      ["full"],
    );
  });
});
