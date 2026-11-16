// Run with `node --test src/stars/notices.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { LookThread } from "./look.ts";
import { NOTHING_SEEN, type NoticeStar, notices, type Seen, waitingThread } from "./notices.ts";

const ask = (name: string) => ({ name, title: `Title of ${name}` });
type Asks = ReturnType<typeof ask>[];
const home = (environmentId: string, asks: Asks, current = true) => ({
  environmentId,
  current,
  asks,
});

const star = (overrides: Partial<NoticeStar> = {}): NoticeStar => ({
  id: "s",
  name: "Vega",
  homes: [home("a", [])],
  drawn: "a",
  waitingOn: null,
  ...overrides,
});
/** A Star with one home, `a`, holding `asks`. */
const asking = (asks: Asks, current = true) => [star({ homes: [home("a", asks, current)] })];

/** Runs the readings in order, each over the last one's `seen`, and returns every result. */
function readings(...each: ReadonlyArray<ReadonlyArray<NoticeStar>>) {
  let seen: Seen = NOTHING_SEEN;
  return each.map((stars) => {
    const result = notices(stars, seen);
    seen = result.seen;
    return result;
  });
}
const shownTags = (results: ReturnType<typeof readings>) =>
  results.map((result) => result.show.map((notice) => notice.tag));

NodeTest.describe("notices", () => {
  NodeTest.it("counts the cards' asks, the drawn home's, across the Stars", () => {
    const [result] = readings([
      star({ homes: [home("a", [ask("x"), ask("y")]), home("b", [ask("z")])] }),
      star({ id: "t", homes: [home("a", [ask("x")])] }),
    ]);
    NodeAssert.equal(result?.badge, 3);
  });

  NodeTest.it("takes a home's first answer as a baseline, and notifies an ask new after it", () => {
    const [first, second] = readings(asking([ask("old")]), asking([ask("old"), ask("new")]));
    NodeAssert.deepEqual(first?.show, []);
    NodeAssert.deepEqual(second?.show, [
      {
        kind: "ask",
        tag: "pult-ask:s:new",
        starId: "s",
        ask: "new",
        title: "Vega",
        body: "Title of new",
      },
    ]);
  });

  NodeTest.it("replays nothing when a home's environment reconnects", () => {
    const results = readings(
      asking([]),
      asking([], false),
      asking([ask("during")]),
      asking([ask("during"), ask("after")]),
    );
    NodeAssert.deepEqual(shownTags(results), [[], [], [], ["pult-ask:s:after"]]);
  });

  NodeTest.it(
    "tells of an ask once, when it reaches the drawn home, whichever home has it first",
    () => {
      const two = (a: Asks, b: Asks, drawn: string) =>
        [star({ homes: [home("a", a), home("b", b)], drawn })] as const;
      const results = readings(
        two([], [], "a"),
        two([], [ask("x")], "a"),
        two([ask("x")], [ask("x")], "a"),
        two([ask("x")], [ask("x")], "b"),
        two([ask("x"), ask("y")], [], "a"),
        two([ask("x"), ask("y")], [ask("y")], "b"),
      );
      NodeAssert.deepEqual(shownTags(results), [
        [],
        [],
        ["pult-ask:s:x"],
        [],
        ["pult-ask:s:y"],
        [],
      ]);
    },
  );

  NodeTest.it("keeps an ask's notification while any home holds the ask, current or not", () => {
    const [result] = readings([star({ homes: [home("a", []), home("b", [ask("x")], false)] })]);
    NodeAssert.deepEqual([...(result?.live ?? [])], ["pult-ask:s:x"]);
  });

  NodeTest.it("notifies a Star entering waiting once, after a reading that knew it was not", () => {
    const waits = (waitingOn: NoticeStar["waitingOn"]) => [star({ waitingOn })];
    const results = readings(
      waits(undefined),
      waits({ title: "Ship it" }),
      waits(null),
      waits({ title: "Ship it" }),
      waits({ title: "Ship it" }),
    );
    NodeAssert.deepEqual(
      results.map((result) => result.show.map((notice) => notice.body)),
      [[], [], [], ["Waiting for you: Ship it"], []],
    );
    NodeAssert.deepEqual(
      results.map((result) => result.live.has("pult-waiting:s")),
      [true, true, false, true, true],
    );
  });

  NodeTest.it(
    "forgets everything while Show Star is off, so turning it on notifies nothing",
    () => {
      const results = readings(asking([ask("x")]), [], asking([ask("x"), ask("y")]));
      NodeAssert.deepEqual(
        results.map((result) => [result.badge, result.show.length, result.live.size]),
        [
          [1, 0, 1],
          [0, 0, 0],
          [2, 0, 2],
        ],
      );
    },
  );
});

const thread = (id: string, overrides: Partial<LookThread> = {}) => ({
  environmentId: "a",
  id,
  rootId: id,
  title: `Thread ${id}`,
  working: false,
  waiting: false,
  awaitsUser: false,
  assistantStreaming: false,
  latestRun: null,
  ...overrides,
});
const homes = [{ environmentId: "a", projectId: "p" }];

NodeTest.describe("waitingThread", () => {
  NodeTest.it("reads the conversation from the store's live row, not the Star's", () => {
    const stale = thread("c");
    const live = thread("c", { awaitsUser: true });
    NodeAssert.equal(waitingThread({ channels: [{ thread: stale }], homes }, [live]), live);
  });

  NodeTest.it("names a thread below the conversation when it is the one awaiting", () => {
    const conversation = thread("c", { working: true });
    const below = thread("sub", { rootId: "c", awaitsUser: true });
    NodeAssert.equal(
      waitingThread({ channels: [{ thread: conversation }], homes }, [conversation, below]),
      below,
    );
  });

  NodeTest.it("is null while the look is not waiting, a failed run's trouble before it", () => {
    const failed = thread("c", {
      awaitsUser: true,
      latestRun: { status: "failed", startedAt: null, finishedAt: null },
    });
    NodeAssert.equal(waitingThread({ channels: [{ thread: failed }], homes }, [failed]), null);
  });
});
