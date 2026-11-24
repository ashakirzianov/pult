import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { fitTabs } from "./fitTabs.ts";

const tabs = (active: number, count = 5) =>
  Array.from({ length: count }, (_, index) => ({ id: index, active: index === active }));
const ids = (list: readonly { id: number }[]) => list.map((tab) => tab.id);

NodeTest.test("every tab shows while they fit", () => {
  const { shown, hidden } = fitTabs(tabs(0), 125, 25);
  NodeAssert.deepEqual([ids(shown), ids(hidden)], [[0, 1, 2, 3, 4], []]);
});

NodeTest.test("the tabs that do not fit are hidden, in their order", () => {
  const { shown, hidden } = fitTabs(tabs(1), 80, 25);
  NodeAssert.deepEqual(
    [ids(shown), ids(hidden)],
    [
      [0, 1, 2],
      [3, 4],
    ],
  );
});

NodeTest.test("the open tab stays, in the last place's stead", () => {
  const { shown, hidden } = fitTabs(tabs(4), 80, 25);
  NodeAssert.deepEqual(
    [ids(shown), ids(hidden)],
    [
      [0, 1, 4],
      [2, 3],
    ],
  );
});

NodeTest.test("with room for less than one, the open tab alone stays", () => {
  const { shown, hidden } = fitTabs(tabs(3), 10, 25);
  NodeAssert.deepEqual([ids(shown), ids(hidden)], [[3], [0, 1, 2, 4]]);
});
