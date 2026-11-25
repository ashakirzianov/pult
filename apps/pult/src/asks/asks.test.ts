// Run with `node --test src/asks/asks.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { replyDestination } from "./asks.ts";

const beta = { name: "Beta", defaultChannel: "main" };
const starOf = (starId: string) => (starId === "beta" ? beta : undefined);
const fromStar = (channel: string) => ({
  environmentId: "env",
  poster: { star: "beta", channel },
});
const fromThread = { environmentId: "env", poster: { thread: "t1" } };
const threadOf = (settled: boolean) => (environmentId: string, threadId: string) =>
  environmentId === "env" && threadId === "t1"
    ? { title: "Separate skipped rows", settled }
    : undefined;

NodeTest.test(
  "a reply's destination names its poster, tells what the page knows of it, and has a thread but for a sleeping channel",
  () => {
    NodeAssert.deepEqual(replyDestination(fromStar("ui-batch-5"), starOf, threadOf(false), true), {
      name: "Beta · ui-batch-5",
      note: "into its open conversation",
      thread: true,
    });
    NodeAssert.deepEqual(replyDestination(fromStar("ui-batch-5"), starOf, threadOf(false), false), {
      name: "Beta · ui-batch-5",
      note: "asleep, wakes in a new conversation",
      thread: false,
    });
    // The default channel goes by the Star's name alone.
    NodeAssert.equal(
      replyDestination(fromStar("main"), starOf, threadOf(false), true).name,
      "Beta",
    );
    NodeAssert.deepEqual(replyDestination(fromThread, starOf, threadOf(false), null), {
      name: "Separate skipped rows",
      note: null,
      thread: true,
    });
    NodeAssert.deepEqual(replyDestination(fromThread, starOf, threadOf(true), null), {
      name: "Separate skipped rows",
      note: "settled, comes back with your reply",
      thread: true,
    });
  },
);
