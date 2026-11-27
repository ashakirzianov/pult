// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { resolveGitWorktreePath, resolveWorktreeT3Home } from "./devHome.ts";

const MONORE_CHECKOUT_ID = "c078d1e2-6c3d-421c-b76d-a859c655780a";

const makeRepo = (
  kind:
    | "worktree"
    | "checkout"
    | "bare"
    | "submodule"
    | "unreadable-git-file"
    | "bare-repo-worktree"
    | "custom-common-dir-worktree"
    | "monore-checkout"
    | "monore-checkout-in-git-folder",
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "bare-repo-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/myrepo.git/worktrees/x\n");
      } else if (kind === "custom-common-dir-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/store/worktrees/x\n");
      } else if (kind === "submodule") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/modules/sub\n");
      } else if (kind === "unreadable-git-file") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "not a gitdir pointer\n");
      } else if (kind === "monore-checkout" || kind === "monore-checkout-in-git-folder") {
        NodeFS.writeFileSync(NodePath.join(root, ".monore-checkout"), `${MONORE_CHECKOUT_ID}\n`);
        if (kind === "monore-checkout-in-git-folder") NodeFS.mkdirSync(NodePath.join(root, ".git"));
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { root, nested };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

describe("resolveGitWorktreePath", () => {
  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a main checkout as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a submodule as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("submodule");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Pult: a monore checkout has no `.git`; its marker makes it a worktree of its own.
  it.effect("finds a monore checkout's root as a worktree", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("monore-checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
      // A marker that holds no checkout's id is no checkout's.
      NodeFS.writeFileSync(NodePath.join(root, ".monore-checkout"), "");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a folder that is both a monore checkout and a git repository", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("monore-checkout-in-git-folder");
      const exit = yield* Effect.exit(resolveGitWorktreePath(nested));
      assert.isTrue(Exit.hasDies(exit));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("bare-repo-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorktreeT3Home", () => {
  it.effect("answers with .t3 before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorktreeT3Home(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".t3"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
