import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { historyItem, historyRefs, refsChange } from "./history.ts";

const HEAD = "a".repeat(40);
const UPSTREAM = "b".repeat(40);
const MAIN = "c".repeat(40);

const result = (
  head: { ref: string | null; sha: string | null } = { ref: "refs/heads/fix", sha: HEAD },
) => ({
  head,
  refs: [
    { name: "refs/heads/fix", sha: HEAD, upstream: "refs/remotes/origin/fix" },
    { name: "refs/heads/main", sha: MAIN, upstream: "refs/remotes/origin/main" },
    { name: "refs/remotes/origin/fix", sha: UPSTREAM, upstream: null },
    { name: "refs/remotes/origin/main", sha: MAIN, upstream: null },
    { name: "refs/tags/v1", sha: MAIN, upstream: null },
  ],
});

NodeTest.describe("historyRefs", () => {
  NodeTest.test("names the branch, its upstream and the base the server diffs it against", () => {
    const refs = historyRefs(result(), "origin/main");
    NodeAssert.deepEqual(refs.current, {
      id: "refs/heads/fix",
      name: "fix",
      revision: HEAD,
      color: "scmGraph.historyItemRefColor",
      icon: { id: "target" },
    });
    NodeAssert.equal(refs.remote?.id, "refs/remotes/origin/fix");
    NodeAssert.equal(refs.remote?.revision, UPSTREAM);
    NodeAssert.equal(refs.remote?.color, "scmGraph.historyItemRemoteRefColor");
    NodeAssert.equal(refs.base?.id, "refs/remotes/origin/main");
    NodeAssert.equal(refs.base?.color, "scmGraph.historyItemBaseRefColor");
    NodeAssert.deepEqual(
      refs.all.map((ref) => [ref.name, ref.category]),
      [
        ["fix", "branches"],
        ["main", "branches"],
        ["origin/fix", "remote branches"],
        ["origin/main", "remote branches"],
        ["v1", "tags"],
      ],
    );
  });

  NodeTest.test("finds a base the server names as a local branch", () => {
    NodeAssert.equal(historyRefs(result(), "main").base?.id, "refs/heads/main");
  });

  NodeTest.test("leaves out a base that is the branch's own upstream, or that no ref names", () => {
    const onMain = result({ ref: "refs/heads/main", sha: MAIN });
    NodeAssert.equal(historyRefs(onMain, "origin/main").base, undefined);
    NodeAssert.equal(historyRefs(onMain, "origin/main").remote?.id, "refs/remotes/origin/main");
    NodeAssert.equal(historyRefs(result(), "origin/gone").base, undefined);
    NodeAssert.equal(historyRefs(result(), null).base, undefined);
  });

  NodeTest.test(
    "names a detached HEAD by its commit, and gives an unborn branch no current ref",
    () => {
      const detached = historyRefs(result({ ref: null, sha: HEAD }), null);
      NodeAssert.equal(detached.current?.id, HEAD);
      NodeAssert.equal(detached.current?.name, HEAD.slice(0, 8));
      NodeAssert.equal(detached.remote, undefined);
      const unborn = historyRefs({ head: { ref: "refs/heads/main", sha: null }, refs: [] }, null);
      NodeAssert.equal(unborn.current, undefined);
    },
  );
});

NodeTest.describe("historyItem", () => {
  NodeTest.test("puts the coloured refs first, then branches, remote branches and tags", () => {
    const refs = historyRefs(result({ ref: "refs/heads/main", sha: MAIN }), null);
    const item = historyItem(
      {
        sha: MAIN,
        parents: [UPSTREAM],
        subject: "Ship it",
        message: "Ship it\n\nAll of it.",
        authorName: "Ada",
        authorEmail: "ada@example.com",
        authoredAt: "2026-11-09T12:00:00+01:00",
        refs: ["refs/tags/v1", "refs/remotes/origin/main", "refs/heads/main"],
      },
      refs,
    );
    NodeAssert.deepEqual(
      item.references?.map((ref) => [ref.name, ref.color]),
      [
        ["main", "scmGraph.historyItemRefColor"],
        ["origin/main", "scmGraph.historyItemRemoteRefColor"],
        ["v1", undefined],
      ],
    );
    NodeAssert.equal(item.displayId, MAIN.slice(0, 7));
    NodeAssert.deepEqual(item.parentIds, [UPSTREAM]);
    NodeAssert.equal(item.timestamp, Date.parse("2026-11-09T11:00:00Z"));
  });
});

NodeTest.describe("refsChange", () => {
  NodeTest.test("tells nothing when no ref moved", () => {
    NodeAssert.equal(
      refsChange(historyRefs(result(), null), historyRefs(result(), null)),
      undefined,
    );
  });

  NodeTest.test("is silent while only other refs move, and loud when the branch does", () => {
    const before = historyRefs(result(), null);
    const fetched = result();
    fetched.refs[3] = { ...fetched.refs[3]!, sha: HEAD };
    NodeAssert.deepEqual(refsChange(before, historyRefs(fetched, null)), {
      added: [],
      removed: [],
      modified: [historyRefs(fetched, null).all[3]],
      silent: true,
    });
    const committed = result({ ref: "refs/heads/fix", sha: MAIN });
    committed.refs[0] = { ...committed.refs[0]!, sha: MAIN };
    NodeAssert.equal(refsChange(before, historyRefs(committed, null))?.silent, false);
  });
});
