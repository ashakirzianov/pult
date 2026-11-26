// Run with `node --test src/changes/reads.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { CheckoutReads, type Settled } from "./reads.ts";

/** A checkout's reads over a fake server whose answers resolve on demand, a file change during a read reading again at once. */
function harness() {
  const pending: Array<(answer: string) => void> = [];
  /** Each read's delivery, by the order the reads began. */
  const flights: Array<Promise<void>> = [];
  const delivered: Array<Settled<string>> = [];
  let unchanged = 0;
  const track = () => {
    const loading = reads.loading;
    if (loading !== undefined && !flights.includes(loading)) flights.push(loading);
  };
  const reads: CheckoutReads<string> = new CheckoutReads({
    read: () => new Promise<string>((resolve) => pending.push(resolve)),
    keyOf: (answer) => (answer.ok ? answer.value : `failed: ${String(answer.error)}`),
    delivered: (answer) => delivered.push(answer),
    unchanged: () => (unchanged += 1),
    followUp: () => {
      reads.stale();
      track();
    },
  });
  return {
    pending,
    read: (force: boolean) => {
      void reads.read(force);
      track();
    },
    stale: () => {
      reads.stale();
      track();
    },
    reset: () => reads.reset(),
    delivered: () => delivered.map((answer) => (answer.ok ? answer.value : "failed")),
    unchanged: () => unchanged,
    /** Answers the `index`th read, and waits for its delivery. */
    answer: async (index: number, value: string) => {
      pending[index]?.(value);
      await flights[index];
    },
  };
}

NodeTest.describe("CheckoutReads", () => {
  NodeTest.test("a burst of file changes during a read makes one read after it", async () => {
    const { stale, pending, answer } = harness();
    stale();
    for (let i = 0; i < 20; i++) stale();
    NodeAssert.equal(pending.length, 1);
    await answer(0, "a");
    NodeAssert.equal(pending.length, 2);
    await answer(1, "a");
    NodeAssert.equal(pending.length, 2);
  });

  NodeTest.test("delivers an answer once, and again only when it changes", async () => {
    const { read, answer, delivered, unchanged } = harness();
    read(false);
    await answer(0, "a");
    read(false);
    await answer(1, "a");
    NodeAssert.deepEqual(delivered(), ["a"]);
    NodeAssert.equal(unchanged(), 1);
    read(false);
    await answer(2, "b");
    NodeAssert.deepEqual(delivered(), ["a", "b"]);
  });

  NodeTest.test("a forced read supersedes the one in flight, whose answer is dropped", async () => {
    const { read, pending, answer, delivered, unchanged } = harness();
    read(false);
    read(false);
    NodeAssert.equal(pending.length, 1);
    read(true);
    NodeAssert.equal(pending.length, 2);
    await answer(1, "new");
    await answer(0, "old");
    NodeAssert.deepEqual(delivered(), ["new"]);
    NodeAssert.equal(unchanged(), 0);
  });

  NodeTest.test("delivers an equal answer after a reset", async () => {
    const { read, reset, answer, delivered } = harness();
    read(false);
    await answer(0, "a");
    reset();
    read(false);
    await answer(1, "a");
    NodeAssert.deepEqual(delivered(), ["a", "a"]);
  });
});
