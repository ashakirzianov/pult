// Run with `node --test src/panel/order.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ShelfName } from "../threads/store.ts";
import {
  closedShelves,
  closeIn,
  DEFAULT_SHELF_ORDER,
  draftCards,
  explorerEntries,
  jumpTargets,
  moveIn,
  openIn,
  openShelves,
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
    secrets: [],
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
    "reaches the Explorer's files, then the drafts and the secrets, then shelf by shelf the asks and the threads, as the panel lists them",
    () => {
      const targets = jumpTargets(
        panel({
          environmentIds: ["env", "other"],
          files: [file("other", "/b.ts"), file("env", "/a.ts")],
          drafts: [draft("project")],
          secrets: [{ environmentId: "other", threadId: "asker", id: "card" }],
          asks: [
            { environmentId: "env", id: "review", shelf: "inbox" },
            { environmentId: "env", id: "spend", shelf: "settled" },
            { environmentId: "other", id: "access", shelf: "inbox" },
            { environmentId: "env", id: "sent", shelf: "working" },
            { environmentId: "env", id: "later", shelf: "snoozed" },
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
        "secret:other/asker/card",
        "ask:env/review",
        "ask:other/access",
        "env/pinned",
        "env/active",
        "ask:env/sent",
        "env/working",
        "ask:env/later",
        "env/snoozed",
        "ask:env/spend",
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
            asks: [{ environmentId: "env", id: "ask", shelf: "inbox" }],
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

NodeTest.describe("shelf order", () => {
  NodeTest.test("keeps a shelf's place when closed and reopened, including after restart", () => {
    const docked = moveIn(DEFAULT_SHELF_ORDER, "working", "bottom");
    const closed = closeIn(closeIn(docked, "working"), "explorer");
    const restored = parseShelfOrder(JSON.parse(JSON.stringify(closed)), PANEL_SHELVES);
    NodeAssert.ok(restored);
    NodeAssert.deepEqual(closedShelves(restored), ["explorer", "working"]);
    const reopened = openIn(openIn(restored, "working"), "explorer");
    NodeAssert.deepEqual(openShelves(reopened, "top"), docked.top);
    NodeAssert.deepEqual(openShelves(reopened, "bottom"), ["working"]);
  });

  NodeTest.test("moves a shelf within and across groups, including while closed", () => {
    const order = {
      top: ["stars", "inbox", "explorer"],
      bottom: ["working", "settled"],
      closed: ["explorer", "working"],
    };
    NodeAssert.deepEqual(moveIn(order, "stars", "bottom", "working", true), {
      top: ["inbox", "explorer"],
      bottom: ["working", "stars", "settled"],
      closed: order.closed,
    });
    NodeAssert.deepEqual(closedShelves(moveIn(order, "working", "top", "explorer")), [
      "working",
      "explorer",
    ]);
    NodeAssert.equal(moveIn(order, "stars", "top", "inbox"), order);
  });

  NodeTest.test("migrates the previous open and tray orders and adds new shelves", () => {
    NodeAssert.deepEqual(
      parseShelfOrder({ open: ["channels"], closed: ["schedules", "asks"] }, [
        "asks",
        "channels",
        "schedules",
        "settings",
      ]),
      {
        top: ["channels", "schedules", "asks", "settings"],
        bottom: [],
        closed: ["schedules", "asks"],
      },
    );
    NodeAssert.equal(
      parseShelfOrder({ top: ["stars"], bottom: ["stars"], closed: [] }, PANEL_SHELVES),
      null,
    );
    NodeAssert.equal(
      parseShelfOrder({ open: ["stars"], closed: ["unknown"] }, PANEL_SHELVES),
      null,
    );
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
