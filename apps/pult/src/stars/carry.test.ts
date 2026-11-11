// Run with `node --test src/stars/carry.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { carryInto, carryOutOf, type EndedComposer, type WokenDraft } from "./carry.ts";

const ended = (threadId: string, settledAt: string, holds: boolean): EndedComposer => ({
  threadId,
  settledAt,
  holds,
});

const empty = { holds: false };

NodeTest.describe("carryInto", () => {
  NodeTest.test("moves an ended conversation's text into an empty draft", () => {
    NodeAssert.deepEqual(carryInto(empty, [ended("a", "2026-11-10T10:00:00Z", true)]), {
      kind: "move",
      threadId: "a",
    });
  });

  NodeTest.test("moves nothing while no ended conversation holds anything", () => {
    NodeAssert.equal(carryInto(empty, []), undefined);
    NodeAssert.equal(carryInto(empty, [ended("a", "2026-11-10T10:00:00Z", false)]), undefined);
  });

  NodeTest.test("waits for the draft the tab mints", () => {
    NodeAssert.equal(carryInto(null, [ended("a", "2026-11-10T10:00:00Z", true)]), undefined);
  });

  NodeTest.test("takes the one that ended last, of those holding something", () => {
    const composers = [
      ended("older", "2026-11-10T09:00:00Z", true),
      ended("newest", "2026-11-10T11:00:00Z", false),
      ended("later", "2026-11-10T10:00:00+00:00", true),
    ];
    NodeAssert.deepEqual(carryInto(empty, composers), { kind: "move", threadId: "later" });
  });

  NodeTest.test("never moves over what the draft holds: tells it stranded", () => {
    NodeAssert.deepEqual(carryInto({ holds: true }, [ended("a", "2026-11-10T10:00:00Z", true)]), {
      kind: "stranded",
      threadId: "a",
    });
  });
});

const draft = (projectId: string, holds: boolean, createsCurrent = false): WokenDraft => ({
  environmentId: "local",
  projectId,
  holds,
  createsCurrent,
});

NodeTest.describe("carryOutOf", () => {
  NodeTest.test("moves a draft's text into the conversation someone else woke", () => {
    const held = draft("star", true);
    NodeAssert.deepEqual(carryOutOf(empty, [held]), { kind: "move", draft: held });
  });

  NodeTest.test("moves nothing while no draft holds anything", () => {
    NodeAssert.equal(carryOutOf(empty, []), undefined);
    NodeAssert.equal(carryOutOf(empty, [draft("star", false)]), undefined);
  });

  NodeTest.test("leaves the draft that created the conversation, the user's own send", () => {
    NodeAssert.equal(carryOutOf(empty, [draft("star", true, true)]), undefined);
  });

  NodeTest.test("takes a draft of another home, which no tab shows either", () => {
    const other = draft("elsewhere", true);
    NodeAssert.deepEqual(carryOutOf(empty, [draft("star", false), other]), {
      kind: "move",
      draft: other,
    });
  });

  NodeTest.test(
    "never moves over what the conversation's composer holds: tells it stranded",
    () => {
      const held = draft("star", true);
      NodeAssert.deepEqual(carryOutOf({ holds: true }, [held]), { kind: "stranded", draft: held });
    },
  );
});
