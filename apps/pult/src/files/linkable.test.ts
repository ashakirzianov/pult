// Run with `node --test src/files/linkable.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { FileLinkRef } from "../../view/host.ts";
import type { Checkout } from "../changes/checkouts.ts";
import { makeFileLinks, rootsKey } from "./linkable.ts";

const checkout = (root: string, projectId: string): Checkout => ({
  environmentId: "env",
  root,
  projectId,
  projectName: projectId,
  worktree: null,
});

const pult = checkout("/repos/pult", "pult");
const axis = checkout("/repos/axis", "axis");
/** A project whose root is gone, as a deleted worktree's: the server's search of it fails. */
const gone = checkout("/repos/gone", "gone");

/**
 * One environment whose files are `files`, its threads in `/repos/pult` but
 * `star`, a Star's conversation in its folder `/stars/beta`, which is no
 * checkout (`checkoutsOf`), its kept monore checkout at `/monore`.
 */
function environment(files: Array<string>) {
  const metadataCalls: Array<ReadonlyArray<string>> = [];
  const searched: Array<string> = [];
  const runEnds = new Map<string, string | null>();
  const changed: Array<() => void> = [];
  let checkouts = [pult, axis, gone];
  const links = makeFileLinks({
    whenListed: async () => {},
    input: (_environmentId, threadId) => ({
      checkoutRoot: threadId === "star" ? "/stars/beta" : "/repos/pult",
      projectId: threadId === "star" ? "star" : "pult",
      checkouts,
      monoreRoot: "/monore",
      search: async ({ root }, key) => {
        searched.push(`${root} ${key}`);
        if (root === gone.root)
          throw { failure: "workspace_root_not_found", message: `${root} does not exist` };
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
    roots: () =>
      rootsKey(
        checkouts.map((checkout) => checkout.root),
        "/monore",
      ),
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
  const reroot = (next: Array<Checkout>) => {
    checkouts = next;
    for (const listener of changed) listener();
  };
  return { links, verdicts, settle, reroot, metadataCalls, searched };
}

NodeTest.test(
  "a path is a link only where the click would open it, its inputs asked once per batch",
  async () => {
    const files = [
      "/repos/pult/src/a.ts",
      "/repos/axis/docs/b.ts",
      "/repos/pult/x/c.ts",
      "/repos/pult/y/c.ts",
      "/etc/hosts",
      "/monore/owner/track/about.md",
      "/stars/beta/notes.md",
    ];
    const { links, verdicts, settle, reroot, metadataCalls, searched } = environment(files);
    const paths = [
      "src/a.ts",
      "b.ts",
      "c.ts",
      "/etc/hosts",
      "src/missing.ts",
      "/owner/track/about.md",
    ];
    const starPaths = ["/stars/beta/nope/missing.md", "never.md", "/stars/beta/notes.md"];
    const [first, second, star] = await Promise.all([
      verdicts("t1", paths),
      verdicts("t2", ["b.ts"]),
      verdicts("star", starPaths),
    ]);
    NodeAssert.deepEqual(first, [true, true, true, false, false, true]);
    NodeAssert.deepEqual(second, [true]);
    NodeAssert.deepEqual(
      star,
      [false, false, true],
      "in a Star's folder, missing files are no links though a checkout's root is gone",
    );
    NodeAssert.equal(metadataCalls.length, 1);
    NodeAssert.deepEqual(
      searched.toSorted(),
      [
        "/repos/axis b.ts",
        "/repos/axis never.md",
        "/repos/axis nope/missing.md",
        "/repos/axis src/missing.ts",
        "/repos/gone b.ts",
        "/repos/gone never.md",
        "/repos/gone nope/missing.md",
        "/repos/gone src/missing.ts",
        "/repos/pult b.ts",
        "/repos/pult c.ts",
        "/repos/pult never.md",
        "/repos/pult nope/missing.md",
        "/repos/pult src/missing.ts",
      ],
      "each checkout searched once per key, across threads",
    );

    // The gates stay on screen through the run's end; the agent wrote one of the missing files.
    metadataCalls.length = 0;
    searched.length = 0;
    const refs = paths.map((path): FileLinkRef => ({ environmentId: "env", threadId: "t1", path }));
    const notified: Array<string> = [];
    let publish = () => {};
    const published = new Promise<void>((resolve) => (publish = resolve));
    for (const ref of refs)
      links.subscribe(ref, () => {
        notified.push(ref.path);
        publish();
      });
    files.push("/monore/etc/hosts");
    settle("t1", "2026-11-24T12:00:00Z");
    NodeAssert.deepEqual(
      refs.map((ref) => links.verdict(ref)),
      [true, true, true, false, false, true],
      "a no reads as no while it is checked again",
    );
    await published;
    NodeAssert.deepEqual(notified, ["/etc/hosts"], "only the path that now opens is told");
    NodeAssert.deepEqual(
      refs.map((ref) => links.verdict(ref)),
      [true, true, true, true, false, true],
    );
    NodeAssert.deepEqual(metadataCalls, [["/monore/etc/hosts", "/repos/pult/src/missing.ts"]]);
    NodeAssert.deepEqual(searched.toSorted(), [
      "/repos/axis src/missing.ts",
      "/repos/gone src/missing.ts",
      "/repos/pult src/missing.ts",
    ]);

    // The Star's turn wrote one of the files it named: it becomes a link once the turn ends.
    const starRefs = starPaths.map((path): FileLinkRef => ({
      environmentId: "env",
      threadId: "star",
      path,
    }));
    let starPublish = () => {};
    const starPublished = new Promise<void>((resolve) => (starPublish = resolve));
    const starNotified: Array<string> = [];
    for (const ref of starRefs)
      links.subscribe(ref, () => {
        starNotified.push(ref.path);
        starPublish();
      });
    files.push("/stars/beta/never.md");
    settle("star", "2026-11-24T12:05:00Z");
    await starPublished;
    NodeAssert.deepEqual(starNotified, ["never.md"]);
    NodeAssert.deepEqual(
      starRefs.map((ref) => links.verdict(ref)),
      [false, true, true],
    );

    // A worktree thread ends its turn and the store lists the same checkouts in another order.
    NodeAssert.equal(
      rootsKey(["/repos/axis", "/repos/pult"], "/monore"),
      rootsKey(["/repos/pult", "/repos/axis"], "/monore"),
      "the same checkouts in another order are the same roots",
    );
    notified.length = 0;

    // The axis checkout goes: what it held opens nowhere.
    let republish = () => {};
    const republished = new Promise<void>((resolve) => (republish = resolve));
    links.subscribe(refs[1]!, () => republish());
    reroot([pult]);
    NodeAssert.deepEqual(
      refs.map((ref) => links.verdict(ref)),
      [true, true, true, true, false, true],
      "a yes and a no read as they did while they are checked again",
    );
    await republished;
    NodeAssert.deepEqual(notified, ["b.ts"], "only the path that no longer opens is told");
    NodeAssert.deepEqual(
      refs.map((ref) => links.verdict(ref)),
      [true, false, true, true, false, true],
    );
  },
);
