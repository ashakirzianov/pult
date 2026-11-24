// Run with `node --test src/files/linkable.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { FileLinkRef } from "../../view/host.ts";
import type { Checkout } from "../changes/checkouts.ts";
import { makeFileLinks } from "./linkable.ts";

const checkout = (root: string, projectId: string): Checkout => ({
  environmentId: "env",
  root,
  projectId,
  projectName: projectId,
  worktree: null,
});

const pult = checkout("/repos/pult", "pult");
const axis = checkout("/repos/axis", "axis");

/** One environment whose files are `files`, its threads in `/repos/pult`, its kept xaxis checkout at `/xaxis`. */
function environment(files: ReadonlyArray<string>) {
  const metadataCalls: Array<ReadonlyArray<string>> = [];
  const searched: Array<string> = [];
  const runEnds = new Map<string, string | null>();
  const changed: Array<() => void> = [];
  const links = makeFileLinks({
    whenListed: async () => {},
    input: () => ({
      checkoutRoot: "/repos/pult",
      projectId: "pult",
      checkouts: [pult, axis],
      xaxisRoot: "/xaxis",
      search: async ({ root }, key) => {
        searched.push(`${root} ${key}`);
        return files
          .filter((file) => file.startsWith(`${root}/`) && file.endsWith(`/${key}`))
          .map((file) => file.slice(root.length + 1));
      },
    }),
    getMetadata: async (_environmentId, paths) => {
      metadataCalls.push(paths);
      return paths.map((path) => (files.includes(path) ? { kind: "file" } : null));
    },
    runEnd: (_environmentId, threadId) => runEnds.get(threadId) ?? null,
    roots: () => "roots",
    publishMs: 0,
    onDidChange: (listener) => void changed.push(listener),
  });
  const verdicts = (threadId: string, paths: ReadonlyArray<string>) =>
    Promise.all(
      paths.map((path) => {
        const ref: FileLinkRef = { environmentId: "env", threadId, path };
        links.ask(ref);
        return new Promise<boolean | undefined>((resolve) => {
          if (links.verdict(ref) !== undefined) return resolve(links.verdict(ref));
          const stop = links.subscribe(ref, () => {
            if (links.verdict(ref) === undefined) return;
            stop();
            resolve(links.verdict(ref));
          });
        });
      }),
    );
  const settle = (threadId: string, at: string) => {
    runEnds.set(threadId, at);
    for (const listener of changed) listener();
  };
  return { verdicts, settle, metadataCalls, searched };
}

NodeTest.test(
  "a path is a link only where the click would open it, its inputs asked once per batch",
  async () => {
    const { verdicts, settle, metadataCalls, searched } = environment([
      "/repos/pult/src/a.ts",
      "/repos/axis/docs/b.ts",
      "/repos/pult/x/c.ts",
      "/repos/pult/y/c.ts",
      "/etc/hosts",
      "/xaxis/owner/track/about.md",
    ]);
    const paths = [
      "src/a.ts",
      "b.ts",
      "c.ts",
      "/etc/hosts",
      "src/missing.ts",
      "/owner/track/about.md",
    ];
    const [first, second] = await Promise.all([verdicts("t1", paths), verdicts("t2", ["b.ts"])]);
    NodeAssert.deepEqual(first, [true, true, true, false, false, true]);
    NodeAssert.deepEqual(second, [true]);
    NodeAssert.equal(metadataCalls.length, 1);
    NodeAssert.deepEqual(
      searched.toSorted(),
      [
        "/repos/axis b.ts",
        "/repos/axis src/missing.ts",
        "/repos/pult b.ts",
        "/repos/pult c.ts",
        "/repos/pult src/missing.ts",
      ],
      "each checkout searched once per key, across threads",
    );

    metadataCalls.length = 0;
    searched.length = 0;
    settle("t1", "2026-11-24T12:00:00Z");
    NodeAssert.deepEqual(await verdicts("t1", paths), [true, true, true, false, false, true]);
    NodeAssert.deepEqual(metadataCalls, [["/xaxis/etc/hosts", "/repos/pult/src/missing.ts"]]);
    NodeAssert.deepEqual(searched.toSorted(), [
      "/repos/axis src/missing.ts",
      "/repos/pult src/missing.ts",
    ]);
  },
);
