// Run with `node --test src/stars/notices.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { LookThread } from "./look.ts";
import {
  NOTHING_SEEN,
  type NoticeAsks,
  type NoticeSecrets,
  type NoticeStar,
  notices,
  type Seen,
  waitingThread,
} from "./notices.ts";

const ask = (id: string) => ({ id, title: `Title of ${id}`, poster: "Vega" });
const on = (environmentId: string, ids: ReadonlyArray<string>, current = true): NoticeAsks => ({
  environmentId,
  current,
  posted: ids.map(ask),
});

const secrets = (
  environmentId: string,
  keys: ReadonlyArray<string>,
  unread: ReadonlyArray<string> = [],
  current = true,
): NoticeSecrets => ({
  environmentId,
  current,
  posted: keys.map((key) => ({ key, threadId: `t-${key}`, label: `Label ${key}`, poster: "Vega" })),
  unread,
});

const star = (overrides: Partial<NoticeStar> = {}): NoticeStar => ({
  id: "s",
  name: "Vega",
  waitingOn: null,
  ...overrides,
});

/** Runs the readings in order, each over the last one's `seen`, and returns every result. */
function readings(
  ...each: ReadonlyArray<{
    readonly stars?: ReadonlyArray<NoticeStar>;
    readonly asks?: ReadonlyArray<NoticeAsks>;
    readonly secrets?: ReadonlyArray<NoticeSecrets>;
  }>
) {
  let seen: Seen = NOTHING_SEEN;
  return each.map(({ stars = [], asks = [], secrets = [] }) => {
    const result = notices(stars, asks, secrets, seen);
    seen = result.seen;
    return result;
  });
}
const shownTags = (results: ReturnType<typeof readings>) =>
  results.map((result) => result.show.map((notice) => notice.tag));

NodeTest.describe("notices", () => {
  NodeTest.it("counts the posted asks and the secrets across the environments", () => {
    const [result] = readings({
      asks: [on("a", ["x", "y"]), on("b", ["z"], false)],
      secrets: [secrets("a", ["s"], ["unread"]), secrets("b", ["r"], [], false)],
    });
    NodeAssert.equal(result?.badge, 5);
  });

  NodeTest.it(
    "notifies a secret by its label once read, a card unread in the baseline never, and keeps it while it waits",
    () => {
      const results = readings(
        { secrets: [secrets("a", [], ["old"])] },
        { secrets: [secrets("a", ["old"], ["new"])] },
        { secrets: [secrets("a", ["old", "new"])] },
        { secrets: [secrets("a", ["new"], [], false)] },
        { secrets: [secrets("a", [])] },
      );
      NodeAssert.deepEqual(shownTags(results), [[], [], ["pult-secret:new"], [], []]);
      NodeAssert.deepEqual(results[2]?.show[0], {
        kind: "secret",
        tag: "pult-secret:new",
        environmentId: "a",
        threadId: "t-new",
        title: "Label new",
        body: "Vega asks for a secret",
      });
      NodeAssert.deepEqual(
        results.map((result) => [...result.live].toSorted()),
        [
          [],
          ["pult-secret:old"],
          ["pult-secret:new", "pult-secret:old"],
          ["pult-secret:new", "pult-secret:old"],
          [],
        ],
      );
    },
  );

  NodeTest.it(
    "lets a Star's secret stand in for its wait, closing its notice, and waits for an unread card's read",
    () => {
      const waits = (card?: "secret" | "unread") => ({
        stars: [star({ waitingOn: { title: "Ship it", ...(card && { card }) } })],
      });
      const results = readings(
        { stars: [star()] },
        waits("unread"),
        waits("secret"),
        { stars: [star()] },
        waits("unread"),
        waits(),
        waits("secret"),
      );
      NodeAssert.deepEqual(
        results.map((result) => result.show.map((notice) => notice.body)),
        [[], [], [], [], [], ["Waiting for you: Ship it"], []],
      );
      NodeAssert.deepEqual(
        results.map((result) => result.live.has("pult-waiting:s")),
        [false, true, false, false, true, true, false],
      );
    },
  );

  NodeTest.it(
    "takes an environment's first answer as a baseline, and notifies an ask posted after it",
    () => {
      const [first, second] = readings(
        { asks: [on("a", ["old"])] },
        { asks: [on("a", ["old", "new"])] },
      );
      NodeAssert.deepEqual(first?.show, []);
      NodeAssert.deepEqual(second?.show, [
        {
          kind: "ask",
          tag: "pult-ask:a:new",
          environmentId: "a",
          ask: "new",
          title: "Vega",
          body: "Title of new",
        },
      ]);
    },
  );

  NodeTest.it(
    "replays nothing across a reconnect, and notifies an ask posted again after it left Inbox",
    () => {
      const results = readings(
        { asks: [on("a", [])] },
        { asks: [on("a", [], false)] },
        { asks: [on("a", ["during"])] },
        { asks: [on("a", ["during", "after"])] },
        { asks: [on("a", ["during"])] },
        { asks: [on("a", ["during", "after"])] },
      );
      NodeAssert.deepEqual(shownTags(results), [
        [],
        [],
        [],
        ["pult-ask:a:after"],
        [],
        ["pult-ask:a:after"],
      ]);
    },
  );

  NodeTest.it(
    "keeps an ask's notification while it is posted, or its environment is not current",
    () => {
      const results = readings(
        { asks: [on("a", [])] },
        { asks: [on("a", ["x"])] },
        { asks: [on("a", [], false)] },
        { asks: [on("a", [])] },
      );
      NodeAssert.deepEqual(
        results.map((result) => [...result.live]),
        [[], ["pult-ask:a:x"], ["pult-ask:a:x"], []],
      );
    },
  );

  NodeTest.it("notifies a Star entering waiting once, after a reading that knew it was not", () => {
    const waits = (waitingOn: NoticeStar["waitingOn"]) => ({ stars: [star({ waitingOn })] });
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
});

const thread = (id: string, overrides: Partial<LookThread> = {}) => ({
  environmentId: "a",
  id,
  rootId: id,
  title: `Thread ${id}`,
  working: false,
  waiting: false,
  awaitsUser: false,
  latestRun: null,
  ...overrides,
});

NodeTest.describe("waitingThread", () => {
  NodeTest.it("reads the conversation from the store's live row, not the Star's", () => {
    const stale = thread("c");
    const live = thread("c", { awaitsUser: true });
    NodeAssert.equal(waitingThread({ channels: [{ thread: stale }] }, [live]), live);
  });

  NodeTest.it("names a thread below the conversation when it is the one awaiting", () => {
    const conversation = thread("c", { working: true });
    const below = thread("sub", { rootId: "c", awaitsUser: true });
    NodeAssert.equal(
      waitingThread({ channels: [{ thread: conversation }] }, [conversation, below]),
      below,
    );
  });

  NodeTest.it("is null while the look is not waiting, a failed run's trouble before it", () => {
    const failed = thread("c", {
      awaitsUser: true,
      latestRun: { status: "failed", startedAt: null, finishedAt: null },
    });
    NodeAssert.equal(waitingThread({ channels: [{ thread: failed }] }, [failed]), null);
  });
});
