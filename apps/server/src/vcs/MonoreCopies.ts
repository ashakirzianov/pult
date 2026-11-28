// Pult: a thread's copy of a project kept in monore, a second checkout of the root's prefix
// made where git worktrees go, which `GitWorkflowService` answers the worktree calls with
// (monore `pult/decisions`, `monore-copies`, `monore-copy-contract`, `monore-copy-cleanup`).
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import { GitCommandError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as MonoreCli from "./MonoreCli.ts";
import type * as VcsWorkflow from "./VcsWorkflow.ts";

/** The line every copy is on, as the driver's status names any monore checkout's. */
const MAIN = "main";

export const NO_BRANCHES =
  "A project kept in monore has one line, main, and no branches: pass baseRef main and no branch.";

export interface MonoreCopies {
  /**
   * `vcs.createWorktree` for a checkout's root: a copy of its prefix on `main`, at main's tip, or
   * at a checkout's head `base` handed out for `refName`, inheriting its stack.
   */
  readonly create: VcsWorkflow.VcsWorkflow["createCopy"];
  /**
   * Whether `create` copies the checkout whose root is `root`: one of a prefix, not the whole tree.
   * Fails where monore lists no checkout there, as `create` does.
   */
  readonly canCopy: (root: string) => Effect.Effect<boolean, GitCommandError>;
  /** `vcs.removeWorktree` of a copy: `force` lets uncommitted edits go, never a stack or a conflict. */
  readonly remove: VcsWorkflow.VcsWorkflow["removeCopy"];
  /**
   * A base naming the head of the checkout at `cwd`, its commits not landed included, for
   * `delegate_task`'s isolated child to start at: refused during a conflict. Only a base handed out
   * here starts a copy at a changeset, so the tools' `baseRef` names none (`monore-copy-contract`).
   */
  readonly base: VcsWorkflow.VcsWorkflow["copyBase"];
  /**
   * At a thread's settle, `remove` without `force` of its copy at `path`, a copy of the checkout at
   * `cwd` inside the worktrees folder, unless a thread of `activeThreadIds` is still on it.
   */
  readonly cleanSettled: VcsWorkflow.VcsWorkflow["cleanSettledCopy"];
}

export const make = Effect.fn("MonoreCopies.make")(function* (
  cli: MonoreCli.MonoreCli,
  /** The driver's write locks, so a removal waits out a write the server runs in the copy. */
  writeLocks: KeyedLock.KeyedLock<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const refuse = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation,
      command: "monore copy",
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const refused = (error: MonoreCli.MonoreCliError) =>
    error._tag === "MonoreRefusal" ? error.toCommandError() : error;
  const realPath = (operation: string, target: string) =>
    fileSystem
      .realPath(target)
      .pipe(
        Effect.mapError((cause) =>
          refuse(operation, target, `Could not resolve ${target}.`, cause),
        ),
      );
  const status = (operation: string, root: string) =>
    cli
      .json({ operation, cwd: root, args: ["status", "--json"] }, MonoreCli.MonoreStatus)
      .pipe(Effect.mapError(refused));

  const worktreesFolder = Effect.fn("MonoreCopies.worktreesFolder")(function* (
    fail: (detail: string, cause?: unknown) => GitCommandError,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => fail("Could not read the worktrees setting.", cause)),
    );
    const folder = resolveWorktreesDirectory(
      current.worktreesDirectory,
      worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (folder === null) {
      return yield* fail(
        `The worktree location "${current.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
      );
    }
    return folder;
  });

  const randomHex = (bytes: number) =>
    Effect.all(
      Array.from({ length: bytes }, () => Random.nextIntBetween(0, 256, { halfOpen: true })),
    ).pipe(Effect.map((all) => all.map((byte) => byte.toString(16).padStart(2, "0")).join("")));

  /**
   * The bases `base` handed out, `<changeset>#<nonce>`, the only refs `create` starts a copy at a
   * changeset from: a hash alone, or one a tool guesses, is refused. Kept for the server's life,
   * one each delegation, so a retried launch of a delegated child finds its base.
   */
  const bases = new Set<string>();

  /** The listed checkout whose root is `root`, a real path. */
  const sourceOf = Effect.fn("MonoreCopies.sourceOf")(function* (operation: string, root: string) {
    const source = (yield* cli
      .checkouts({ operation: `${operation}.checkouts`, cwd: root })
      .pipe(Effect.mapError(refused))).find((checkout) => checkout.dir === root);
    if (source === undefined) {
      return yield* refuse(
        operation,
        root,
        `${root} is not the root of a checkout this machine's monore lists: only a checkout's root gets a copy.`,
      );
    }
    return source;
  });

  const canCopy: MonoreCopies["canCopy"] = Effect.fn("MonoreCopies.canCopy")(function* (root) {
    const operation = "MonoreCopies.canCopy";
    const source = yield* sourceOf(operation, yield* realPath(operation, root));
    return source.prefix !== "/";
  });

  const create: MonoreCopies["create"] = Effect.fn("MonoreCopies.create")(
    function* (input, progress) {
      const operation = "MonoreCopies.create";
      const fail = (detail: string, cause?: unknown) => refuse(operation, input.cwd, detail, cause);
      const newRef = input.newRefName;
      const at = bases.has(input.refName) ? input.refName.split("#")[0] : undefined;
      if (
        (input.refName !== MAIN && input.refName !== `refs/heads/${MAIN}` && at === undefined) ||
        (newRef !== undefined && newRef !== MAIN && !isTemporaryWorktreeBranch(newRef))
      ) {
        return yield* fail(NO_BRANCHES);
      }

      const root = yield* realPath(operation, input.cwd);
      const source = yield* sourceOf(operation, root);
      if (source.prefix === "/") {
        return yield* fail(`${root} is a checkout of the whole tree, which is not copied.`);
      }

      let dir = input.path;
      if (dir === null) {
        const parent = yield* worktreesFolder(fail);
        dir = path.join(parent, path.basename(root), `copy-${yield* randomHex(4)}`);
      }
      const target = path.resolve(input.cwd, dir);
      const existed = yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true));
      const parentDir = path.dirname(target);
      yield* fileSystem
        .makeDirectory(parentDir, { recursive: true })
        .pipe(Effect.mapError((cause) => fail(`Could not make ${parentDir}.`, cause)));

      if (progress?.onWorktreeClaimed) yield* progress.onWorktreeClaimed(target);
      yield* Effect.gen(function* () {
        yield* cli
          .checkout({
            operation,
            cwd: parentDir,
            server: source.server,
            prefix: source.prefix,
            dir: target,
            ...(at === undefined ? {} : { at }),
          })
          .pipe(
            // The launch's failure names the code: `checkout-stack-incomplete`,
            // `checkout-stack-outside-prefix`, `unknown-changeset`, `not-on-main`, `too-large`, …
            Effect.mapError((error) =>
              error._tag === "MonoreRefusal"
                ? refuse(
                    operation,
                    input.cwd,
                    `monore refused the copy (${error.code}): ${error.message}`,
                    error,
                  )
                : error,
            ),
          );
        const copy = yield* status(`${operation}.status`, target);
        const real = yield* realPath(operation, target);
        if (copy.dir !== real || copy.prefix !== source.prefix || copy.server !== source.server) {
          return yield* fail(
            `monore made ${copy.dir}, a checkout of ${copy.prefix} at ${copy.server}, where a checkout of ${source.prefix} at ${source.server} was asked for at ${real}.`,
          );
        }
      }).pipe(
        // A copy that never finished is nobody's work; one the caller handed in is left to it.
        Effect.onError(() =>
          existed
            ? Effect.void
            : fileSystem.remove(target, { recursive: true, force: true }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("could not remove the folder of a failed copy", {
                    path: target,
                    cause,
                  }),
                ),
              ),
        ),
      );
      return { worktree: { path: target, refName: MAIN } };
    },
  );

  const remove: MonoreCopies["remove"] = Effect.fn("MonoreCopies.remove")(function* (input) {
    const operation = "MonoreCopies.remove";
    const target = path.resolve(input.cwd, input.path);
    const fail = (detail: string, cause?: unknown) => refuse(operation, target, detail, cause);
    // Gone already, as a copy whose launch was rolled back is.
    if (
      !(yield* fileSystem
        .exists(target)
        .pipe(Effect.mapError((cause) => fail(`Could not inspect ${target}.`, cause))))
    ) {
      return;
    }
    const [copy, root] = yield* Effect.all([
      realPath(operation, target),
      realPath(operation, input.cwd),
    ]);
    if (copy === root) return yield* fail(`${copy} is the project's own checkout, not a copy.`);
    // Only a checkout of the root's own prefix, as git removes only a linked worktree.
    const listed = yield* cli
      .checkouts({ operation: `${operation}.checkouts`, cwd: root })
      .pipe(Effect.mapError(refused));
    const source = listed.find((checkout) => checkout.dir === root);
    const entry = listed.find((checkout) => checkout.dir === copy);
    if (
      source === undefined ||
      entry === undefined ||
      entry.prefix !== source.prefix ||
      entry.server !== source.server
    ) {
      return yield* fail(`${copy} is not a copy of the checkout at ${root}.`);
    }
    yield* writeLocks.withLock(
      copy,
      Effect.gen(function* () {
        const read = yield* status(`${operation}.status`, copy);
        if (read.conflict !== null) {
          return yield* fail(
            `${copy} holds a conflict; resolve it and land before removing the copy.`,
          );
        }
        if (read.stack.length > 0) {
          return yield* fail(
            `${copy} holds ${read.stack.length} ${read.stack.length === 1 ? "commit" : "commits"} not landed; land them before removing the copy.`,
          );
        }
        if (input.force !== true && read.changes.length > 0) {
          return yield* fail(
            `${copy} holds ${read.changes.length} uncommitted ${read.changes.length === 1 ? "change" : "changes"}; commit them, or remove the copy with force.`,
          );
        }
        if (input.force !== true && read.interrupted !== null) {
          return yield* fail(
            `${copy} holds a write that stopped partway (${read.interrupted}); finish it, or remove the copy with force.`,
          );
        }
        // The registry prunes a checkout whose folder is gone.
        yield* fileSystem
          .remove(copy, { recursive: true })
          .pipe(Effect.mapError((cause) => fail(`Could not remove ${copy}.`, cause)));
      }),
    );
  });

  const base: MonoreCopies["base"] = Effect.fn("MonoreCopies.base")(function* (cwd) {
    const operation = "MonoreCopies.base";
    const read = yield* status(operation, cwd);
    // A conflict's changesets wait outside the head, so a copy at it would miss them.
    if (read.conflict !== null) {
      return yield* refuse(
        operation,
        cwd,
        "The parent's checkout holds a conflict, which a copy cannot start from: resolve it, or delegate with isolation shared.",
      );
    }
    const handedOut = `${read.head}#${yield* randomHex(8)}`;
    bases.add(handedOut);
    return handedOut;
  });

  const cleanSettled: MonoreCopies["cleanSettled"] = Effect.fn("MonoreCopies.cleanSettled")(
    function* (input) {
      const operation = "MonoreCopies.cleanSettled";
      if (input.activeThreadIds.length > 0) {
        return {
          removed: false,
          reason: `${input.activeThreadIds.length === 1 ? "another thread is" : `${input.activeThreadIds.length} other threads are`} still on it`,
        } as const;
      }
      return yield* Effect.gen(function* () {
        const fail = (detail: string, cause?: unknown) =>
          refuse(operation, input.path, detail, cause);
        const [copy, folder] = yield* Effect.all([
          realPath(operation, input.path),
          worktreesFolder(fail).pipe(Effect.flatMap((folder) => realPath(operation, folder))),
        ]);
        const inside = path.relative(folder, copy);
        if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
          return yield* fail(`${copy} is not in the worktrees folder ${folder}.`);
        }
        yield* remove({ cwd: input.cwd, path: copy });
        return { removed: true } as const;
      }).pipe(
        Effect.catch((error) => Effect.succeed({ removed: false, reason: error.detail } as const)),
      );
    },
  );

  return { create, canCopy, remove, base, cleanSettled } satisfies MonoreCopies;
});
