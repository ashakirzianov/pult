// Run with `node --test src/threads/navigation.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { PlaceHistory } from "./navigation.ts";

/** A place as the selection records it, plain: a selection's name and its tab's. */
interface Place {
  readonly selection: string;
  readonly tab: string;
}

const place = (selection: string, tab = "lead"): Place => ({ selection, tab });
const same = (left: Place, right: Place) =>
  left.selection === right.selection && left.tab === right.tab;
const always = (_place: Place) => true;

function visited(...places: Place[]): PlaceHistory<Place> {
  const history = new PlaceHistory(same);
  for (const each of places) history.push(each);
  return history;
}

/** One step as the selection takes it: the place it lands on, committed, or undefined where there is none. */
function step(history: PlaceHistory<Place>, way: "back" | "forward", usable = always) {
  const index = way === "back" ? history.back(usable) : history.forward(usable);
  if (index === undefined) return undefined;
  history.commit(index);
  return history.at(index);
}

NodeTest.test("back crosses selections and returns to the tab left", () => {
  const history = visited(place("star", "file-a"), place("thread"), place("explorer", "file-b"));
  NodeAssert.deepEqual(step(history, "back"), place("thread"));
  NodeAssert.deepEqual(step(history, "back"), place("star", "file-a"));
  NodeAssert.equal(step(history, "back"), undefined);
});

NodeTest.test("forward goes again where back came from", () => {
  const history = visited(place("star"), place("thread"), place("explorer", "file"));
  step(history, "back");
  step(history, "back");
  NodeAssert.deepEqual(step(history, "forward"), place("thread"));
  NodeAssert.deepEqual(step(history, "forward"), place("explorer", "file"));
  NodeAssert.equal(step(history, "forward"), undefined);
});

NodeTest.test("a new place after back drops the forward entries", () => {
  const history = visited(place("star"), place("thread"), place("explorer"));
  step(history, "back");
  history.push(place("draft"));
  NodeAssert.equal(step(history, "forward"), undefined);
  NodeAssert.deepEqual(step(history, "back"), place("thread"));
});

NodeTest.test("arriving where the history stands keeps the forward entries", () => {
  const history = visited(place("star"), place("thread"));
  step(history, "back");
  // The landing's own events, after the navigation, record the place it landed on.
  history.push(place("star"));
  NodeAssert.deepEqual(step(history, "forward"), place("thread"));
});

NodeTest.test("the same place twice is one entry", () => {
  const history = visited(place("star"), place("thread"), place("thread"), place("thread"));
  NodeAssert.deepEqual(step(history, "back"), place("star"));
});

NodeTest.test("an unusable entry is skipped both ways and comes back once usable", () => {
  const history = visited(place("star"), place("deleted"), place("thread"));
  let gone = true;
  const usable = (each: Place) => !(gone && each.selection === "deleted");
  NodeAssert.deepEqual(step(history, "back", usable), place("star"));
  NodeAssert.deepEqual(step(history, "forward", usable), place("thread"));
  gone = false;
  NodeAssert.deepEqual(step(history, "back", usable), place("deleted"));
});

NodeTest.test("an entry of the place where the history stands is no step", () => {
  // The thread between the two visits of the Star was deleted, so the earlier Star is where Back would land.
  const history = visited(place("star"), place("deleted"), place("star"));
  NodeAssert.equal(
    step(history, "back", (each) => each.selection !== "deleted"),
    undefined,
  );
});

NodeTest.test("a rewritten draft is the thread", () => {
  const history = visited(place("draft"), place("star"), place("draft", "file"));
  history.rewrite((each) => (each.selection === "draft" ? { ...each, selection: "thread" } : each));
  history.push(place("thread", "file"));
  NodeAssert.deepEqual(step(history, "back"), place("star"));
  NodeAssert.deepEqual(step(history, "back"), place("thread"));
  NodeAssert.deepEqual(step(history, "forward"), place("star"));
  NodeAssert.deepEqual(step(history, "forward"), place("thread", "file"));
});

NodeTest.test("the history keeps the latest places up to its cap", () => {
  const history = new PlaceHistory(same, 3);
  for (const name of ["a", "b", "c", "d"]) history.push(place(name));
  NodeAssert.deepEqual(step(history, "back"), place("c"));
  NodeAssert.deepEqual(step(history, "back"), place("b"));
  NodeAssert.equal(step(history, "back"), undefined);
});
