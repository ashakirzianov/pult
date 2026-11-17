// Pult: a thread's copy of a project kept in xaxis, a second checkout of the root's prefix
// made where git worktrees go, which `GitWorkflowService` answers the worktree calls with
// (xaxis `pult/decisions`, `xaxis-copies`, `xaxis-copy-contract`, `xaxis-copy-cleanup`).
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import * as XaxisCli from "./XaxisCli.ts";

/** The line every copy is on, as the driver's status names any xaxis checkout's. */
const MAIN = "main";

export const NO_BRANCHES =
  "A project kept in xaxis has one line, main, and no branches: pass baseRef main and no branch.";

export interface XaxisCopies {
  /** `vcs.createWorktree` for a checkout's root: a copy of its prefix, on `main`. */
  readonly create: (
    input: VcsCreateWorktreeInput,
    progress?: GitVcsDriver.CreateWorktreeProgress,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  /** `vcs.removeWorktree` of a copy: `force` lets uncommitted edits go, never a stack or a conflict. */
  readonly remove: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
}

export const make = Effect.fn("XaxisCopies.make")(function* (
  cli: XaxisCli.XaxisCli,
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
      command: "xaxis copy",
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const refused = (error: XaxisCli.XaxisCliError) =>
    error._tag === "XaxisRefusal" ? error.toCommandError() : error;
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
      .json({ operation, cwd: root, args: ["status", "--json"] }, XaxisCli.XaxisStatus)
      .pipe(Effect.mapError(refused));

  const create: XaxisCopies["create"] = Effect.fn("XaxisCopies.create")(
    function* (input, progress) {
      const operation = "XaxisCopies.create";
      const fail = (detail: string, cause?: unknown) => refuse(operation, input.cwd, detail, cause);
      const newRef = input.newRefName;
      if (
        (input.refName !== MAIN && input.refName !== `refs/heads/${MAIN}`) ||
        (newRef !== undefined && newRef !== MAIN && !isTemporaryWorktreeBranch(newRef))
      ) {
        return yield* fail(NO_BRANCHES);
      }

      const root = yield* realPath(operation, input.cwd);
      const source = (yield* cli
        .checkouts({ operation: `${operation}.checkouts`, cwd: root })
        .pipe(Effect.mapError(refused))).find((checkout) => checkout.dir === root);
      if (source === undefined) {
        return yield* fail(
          `${root} is not the root of a checkout this machine's xaxis lists: only a checkout's root gets a copy.`,
        );
      }
      if (source.prefix === "/") {
        return yield* fail(`${root} is a checkout of the whole tree, which is not copied.`);
      }

      let dir = input.path;
      if (dir === null) {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError((cause) => fail("Could not read the worktrees setting.", cause)),
        );
        const parent = resolveWorktreesDirectory(
          current.worktreesDirectory,
          worktreesDir,
          path,
          yield* HostProcess.HomeDirectory,
        );
        if (parent === null) {
          return yield* fail(
            `The worktree location "${current.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
          );
        }
        const bytes = yield* Effect.all(
          Array.from({ length: 4 }, () => Random.nextIntBetween(0, 256, { halfOpen: true })),
        );
        const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
        dir = path.join(parent, path.basename(root), `copy-${hex}`);
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
          })
          .pipe(Effect.mapError(refused));
        const copy = yield* status(`${operation}.status`, target);
        const real = yield* realPath(operation, target);
        if (copy.dir !== real || copy.prefix !== source.prefix || copy.server !== source.server) {
          return yield* fail(
            `xaxis made ${copy.dir}, a checkout of ${copy.prefix} at ${copy.server}, where a checkout of ${source.prefix} at ${source.server} was asked for at ${real}.`,
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

  const remove: XaxisCopies["remove"] = Effect.fn("XaxisCopies.remove")(function* (input) {
    const operation = "XaxisCopies.remove";
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

  return { create, remove } satisfies XaxisCopies;
});
