// Pult: `review.getLog` and `review.getRefs` (xaxis `pult/issues/scm-history`).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReviewLog from "./ReviewLog.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-log-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "ReviewLog.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

/** A repository with `main` and its upstream `origin/main` one commit behind, a side branch merged in, and a tag. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-log-" });
  const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-log-remote-" });
  yield* driver.initRepo({ cwd });
  yield* git(cwd, ["config", "user.email", "ada@example.com"]);
  yield* git(cwd, ["config", "user.name", "Ada"]);
  yield* git(cwd, ["checkout", "-b", "main"]);
  yield* fileSystem.writeFileString(`${cwd}/README.md`, "# log\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
  yield* git(cwd, ["tag", "-a", "v1", "-m", "first release"]);
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "-u", "origin", "main"]);
  yield* git(cwd, ["checkout", "-b", "side"]);
  yield* git(cwd, ["commit", "--allow-empty", "-m", "side change"]);
  yield* git(cwd, ["checkout", "main"]);
  yield* git(cwd, ["commit", "--allow-empty", "-m", "main change\n\nWith a body."]);
  yield* git(cwd, ["merge", "--no-ff", "--no-edit", "side"]);
  // A checkpoint ref, as threads leave them, which no history shows.
  yield* git(cwd, ["update-ref", "refs/t3/checkpoint", "HEAD"]);
  return cwd;
});

describe("ReviewLog", () => {
  it.effect("pages HEAD's commits newest first, each with its parents, message and refs", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeRepository;
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const initial = yield* git(cwd, ["rev-parse", "v1^{commit}"]);

      const first = yield* ReviewLog.getLog(driver, { cwd, limit: 2 });
      assert.isTrue(first.hasMore);
      assert.deepEqual(
        first.commits.map((commit) => commit.subject),
        ["Merge branch 'side'", "side change"],
      );
      const merge = first.commits[0]!;
      assert.equal(merge.sha, head);
      assert.equal(merge.parents.length, 2);
      assert.equal(merge.parents[0], yield* git(cwd, ["rev-parse", "HEAD^1"]));
      assert.deepEqual(merge.refs, ["refs/heads/main"]);
      assert.equal(merge.authorName, "Ada");
      assert.equal(merge.authorEmail, "ada@example.com");
      assert.isFalse(Number.isNaN(Date.parse(merge.authoredAt)));
      assert.deepEqual(first.commits[1]!.refs, ["refs/heads/side"]);

      const rest = yield* ReviewLog.getLog(driver, { cwd, skip: 2, limit: 10 });
      assert.isFalse(rest.hasMore);
      assert.deepEqual(
        rest.commits.map((commit) => commit.subject),
        ["main change", "initial commit"],
      );
      assert.equal(rest.commits[0]!.message, "main change\n\nWith a body.");
      const root = rest.commits[1]!;
      assert.equal(root.sha, initial);
      assert.deepEqual(root.parents, []);
      assert.sameMembers([...root.refs], ["refs/remotes/origin/main", "refs/tags/v1"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("walks the refs it is given, and nothing before the first commit", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeRepository;
      const side = yield* ReviewLog.getLog(driver, { cwd, refs: ["refs/remotes/origin/main"] });
      assert.deepEqual(
        side.commits.map((commit) => commit.subject),
        ["initial commit"],
      );
      // A revision is never read as an option.
      yield* Effect.flip(ReviewLog.getLog(driver, { cwd, refs: ["--output=/tmp/pwned"] }));

      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-log-empty-" });
      yield* driver.initRepo({ cwd: empty });
      assert.deepEqual(yield* ReviewLog.getLog(driver, { cwd: empty }), {
        commits: [],
        hasMore: false,
      });
      assert.deepEqual(yield* ReviewLog.getRefs(driver, { cwd: empty }), {
        head: { ref: yield* git(empty, ["symbolic-ref", "HEAD"]), sha: null },
        refs: [],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("lists HEAD and every branch, remote branch and tag with its commit and upstream", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeRepository;
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const initial = yield* git(cwd, ["rev-parse", "v1^{commit}"]);
      const side = yield* git(cwd, ["rev-parse", "side"]);
      yield* git(cwd, ["remote", "set-head", "origin", "main"]);

      const refs = yield* ReviewLog.getRefs(driver, { cwd });
      assert.deepEqual(refs.head, { ref: "refs/heads/main", sha: head });
      assert.deepEqual(refs.refs, [
        { name: "refs/heads/main", sha: head, upstream: "refs/remotes/origin/main" },
        { name: "refs/heads/side", sha: side, upstream: null },
        { name: "refs/remotes/origin/main", sha: initial, upstream: null },
        // The annotated tag at its commit, not its tag object.
        { name: "refs/tags/v1", sha: initial, upstream: null },
      ]);

      yield* git(cwd, ["checkout", "--detach", "side"]);
      assert.deepEqual((yield* ReviewLog.getRefs(driver, { cwd })).head, { ref: null, sha: side });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("parseDecorations", () => {
  it("keeps branches, remote branches and tags, by their full names", () => {
    assert.deepEqual(
      ReviewLog.parseDecorations(
        "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/stash",
      ),
      ["refs/heads/main", "refs/tags/v1", "refs/remotes/origin/main"],
    );
    assert.deepEqual(ReviewLog.parseDecorations("HEAD"), []);
    assert.deepEqual(ReviewLog.parseDecorations(""), []);
  });
});
