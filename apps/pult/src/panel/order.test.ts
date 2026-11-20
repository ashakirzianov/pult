// Run with `node --test src/panel/order.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ShelfName } from "../threads/store.ts";
import {
  closeIn,
  DEFAULT_SHELF_ORDER,
  draftCards,
  explorerEntries,
  inboxRows,
  jumpTargets,
  moveIn,
  openIn,
  PANEL_SHELVES,
  type PanelRows,
  parseShelfOrder,
} from "./order.ts";

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

function panel(
  overrides: Partial<PanelRows<ReturnType<typeof file>, ReturnType<typeof thread>>> = {},
) {
  return {
    stars: [],
    environmentIds: ["env"],
    files: [],
    drafts: [],
    asks: [],
    threads: [],
    selection: undefined,
    open: PANEL_SHELVES,
    settledCount: 10,
    ...overrides,
  };
}

const keys = (targets: ReadonlyArray<{ readonly key: string }>) =>
  targets.map((target) => target.key);

NodeTest.describe("jumpTargets", () => {
  NodeTest.test(
    "reaches the Explorer's files, then the drafts, the asks, then the threads shelf by shelf, as the panel lists them",
    () => {
      const targets = jumpTargets(
        panel({
          environmentIds: ["env", "other"],
          files: [file("other", "/b.ts"), file("env", "/a.ts")],
          drafts: [draft("project")],
          asks: [
            { starId: "beta", name: "review.md" },
            { starId: "beta", name: "spend.md" },
            { starId: "gamma", name: "access.md" },
          ],
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
        "ask:beta/review.md",
        "ask:beta/spend.md",
        "ask:gamma/access.md",
        "env/pinned",
        "env/active",
        "env/working",
        "env/snoozed",
        "env/settled",
      ]);
    },
  );

  NodeTest.test("reaches the shelves' rows in the open shelves' order", () => {
    const targets = jumpTargets(
      panel({
        stars: ["one"],
        files: [file("env", "/a.ts")],
        threads: [thread("active", "active"), thread("working", "working")],
        open: ["explorer", "stars", "working", "limits"],
      }),
    );
    NodeAssert.deepEqual(keys(targets), ["pult://env/a.ts", "star:one", "env/working"]);
  });

  NodeTest.test("reaches no row of a closed shelf, not even the selected one", () => {
    const threads = [
      thread("active", "active"),
      thread("working", "working"),
      thread("snoozed", "snoozed"),
      thread("old", "settled"),
    ];
    const files = [file("env", "/a.ts")];
    NodeAssert.deepEqual(
      keys(
        jumpTargets(
          panel({
            stars: ["one"],
            files,
            asks: [{ starId: "one", name: "ask.md" }],
            threads,
            open: [],
            selection: "env/active",
          }),
        ),
      ),
      [],
    );
    NodeAssert.deepEqual(
      keys(
        jumpTargets(
          panel({
            stars: ["one"],
            files,
            threads,
            open: ["explorer", "inbox", "snoozed", "limits"],
            selection: "env/working",
          }),
        ),
      ),
      ["pult://env/a.ts", "env/active", "env/snoozed"],
    );
  });

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
        files: [file("gone", "/a.ts")],
        threads: [thread("one", "active")],
      }),
    );
    NodeAssert.deepEqual(keys(targets), ["pult://gone/a.ts"]);
  });
});

NodeTest.describe("inboxRows", () => {
  NodeTest.test("counts Inbox's asks among its rows, which its tray icon shows", () => {
    const rows = (asks: ReadonlyArray<{ starId: string; name: string }>) =>
      inboxRows({
        drafts: [draft("project")],
        asks,
        threads: [thread("active", "active"), thread("working", "working")],
        environmentIds: ["env"],
      }).length;
    NodeAssert.equal(rows([]), 2);
    NodeAssert.equal(
      rows([
        { starId: "beta", name: "a.md" },
        { starId: "beta", name: "b.md" },
        { starId: "gamma", name: "c.md" },
      ]),
      5,
    );
  });
});

NodeTest.describe("shelf order", () => {
  NodeTest.test(
    "appends a closed shelf to the closed ones' end and a reopened one to its group's end",
    () => {
      const closed = closeIn(closeIn(closeIn(DEFAULT_SHELF_ORDER, "working"), "stars"), "explorer");
      NodeAssert.deepEqual(closed, {
        open: ["inbox", "snoozed", "settled", "limits"],
        closed: ["working", "stars", "explorer"],
      });
      NodeAssert.deepEqual(openIn(closed, "working").open, [
        "inbox",
        "snoozed",
        "settled",
        "limits",
        "working",
      ]);
      NodeAssert.deepEqual(openIn(openIn(closed, "explorer"), "stars").open, [
        "inbox",
        "explorer",
        "stars",
        "snoozed",
        "settled",
        "limits",
      ]);
      const onlyBottom = { open: ["snoozed"], closed: ["stars", "inbox"] } as const;
      NodeAssert.deepEqual(openIn(onlyBottom, "stars").open, ["stars", "snoozed"]);
    },
  );

  NodeTest.test("keeps a shelf already where it is asked to go in its place", () => {
    const order = closeIn(DEFAULT_SHELF_ORDER, "inbox");
    NodeAssert.equal(openIn(order, "explorer"), order);
    NodeAssert.equal(closeIn(order, "inbox"), order);
  });

  NodeTest.test("closes a shelf at a given place among the closed", () => {
    const order = closeIn(closeIn(DEFAULT_SHELF_ORDER, "working"), "stars");
    NodeAssert.deepEqual(closeIn(order, "explorer", 0).closed, ["explorer", "working", "stars"]);
  });

  NodeTest.test("moves a dragged shelf before another, or to its group's end", () => {
    NodeAssert.deepEqual(moveIn(DEFAULT_SHELF_ORDER, "inbox", "open", "stars").open, [
      "inbox",
      "stars",
      "explorer",
      "working",
      "snoozed",
      "settled",
      "limits",
    ]);
    NodeAssert.deepEqual(moveIn(DEFAULT_SHELF_ORDER, "working", "open", null).open, [
      "stars",
      "explorer",
      "inbox",
      "snoozed",
      "settled",
      "limits",
      "working",
    ]);
  });

  NodeTest.test("keeps a dragged shelf within its group in the panel", () => {
    // Above the top group, a bottom shelf lands at its own group's top; below it, a top shelf at its own's end.
    NodeAssert.deepEqual(moveIn(DEFAULT_SHELF_ORDER, "limits", "open", "explorer").open, [
      "stars",
      "explorer",
      "inbox",
      "limits",
      "working",
      "snoozed",
      "settled",
    ]);
    NodeAssert.deepEqual(moveIn(DEFAULT_SHELF_ORDER, "stars", "open", null).open, [
      "explorer",
      "inbox",
      "stars",
      "working",
      "snoozed",
      "settled",
      "limits",
    ]);
  });

  NodeTest.test("opens a shelf dragged out of a tray, and closes one dragged into it", () => {
    const order = closeIn(closeIn(DEFAULT_SHELF_ORDER, "working"), "stars");
    NodeAssert.deepEqual(moveIn(order, "stars", "open", "inbox"), {
      open: ["explorer", "stars", "inbox", "snoozed", "settled", "limits"],
      closed: ["working"],
    });
    NodeAssert.deepEqual(moveIn(order, "stars", "open", "snoozed").open, [
      "explorer",
      "inbox",
      "stars",
      "snoozed",
      "settled",
      "limits",
    ]);
    NodeAssert.deepEqual(moveIn(order, "inbox", "closed", "stars"), {
      open: ["explorer", "snoozed", "settled", "limits"],
      closed: ["working", "inbox", "stars"],
    });
  });

  NodeTest.test("keeps the order a drop does not change", () => {
    NodeAssert.equal(moveIn(DEFAULT_SHELF_ORDER, "inbox", "open", "inbox"), DEFAULT_SHELF_ORDER);
    NodeAssert.equal(moveIn(DEFAULT_SHELF_ORDER, "inbox", "open", "working"), DEFAULT_SHELF_ORDER);
    NodeAssert.equal(moveIn(DEFAULT_SHELF_ORDER, "limits", "open", null), DEFAULT_SHELF_ORDER);
  });

  NodeTest.test(
    "reads back a stored order, its top group first, and nothing that misses or repeats a shelf",
    () => {
      const order = closeIn(DEFAULT_SHELF_ORDER, "settled");
      NodeAssert.deepEqual(parseShelfOrder(JSON.parse(JSON.stringify(order))), order);
      NodeAssert.deepEqual(
        parseShelfOrder({
          open: ["limits", "explorer", "working", "stars"],
          closed: ["inbox", "snoozed", "settled"],
        }),
        {
          open: ["explorer", "stars", "limits", "working"],
          closed: ["inbox", "snoozed", "settled"],
        },
      );
      NodeAssert.equal(parseShelfOrder({ open: ["inbox"], closed: [] }), null);
      NodeAssert.equal(
        parseShelfOrder({ open: [...PANEL_SHELVES.slice(1), "inbox"], closed: [] }),
        null,
      );
      NodeAssert.equal(parseShelfOrder("stars"), null);
    },
  );
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

NodeTest.describe("explorerEntries", () => {
  NodeTest.test(
    "lists each environment's row with its files nested under it while several are held",
    () => {
      const entries = explorerEntries(
        ["env", "other"],
        [file("other", "/b.ts"), file("gone", "/c.ts"), file("env", "/a.ts")],
      );
      NodeAssert.deepEqual(
        entries.map((entry) => (entry.kind === "file" ? [entry.key, entry.nested] : [entry.key])),
        [
          ["environment:env"],
          ["pult://env/a.ts", true],
          ["environment:other"],
          ["pult://other/b.ts", true],
          ["pult://gone/c.ts", false],
        ],
      );
    },
  );

  NodeTest.test("has no environment row while one is held, its files still nested", () => {
    const entries = explorerEntries(["env"], [file("gone", "/c.ts"), file("env", "/a.ts")]);
    NodeAssert.deepEqual(
      entries.map((entry) => (entry.kind === "file" ? [entry.key, entry.nested] : [entry.key])),
      [
        ["pult://env/a.ts", true],
        ["pult://gone/c.ts", false],
      ],
    );
  });
});
