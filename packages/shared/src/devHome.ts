/** Worktrees use isolated .t3 state; ambient T3CODE_HOME could otherwise select the live userdata database. */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// Match worktrees/<name>; bare repos and GIT_COMMON_DIR need not use a directory named .git.
const pointsAtLinkedWorktree = (gitFileContents: string, path: Path.Path): boolean => {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) {
    return false;
  }
  const segments = path
    .normalize(gitdir.replaceAll("\\", "/"))
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
};

const XAXIS_CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const resolveGitWorktreePath = Effect.fn("devHome.resolveGitWorktreePath")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let directory = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(directory, ".git");
    const info = yield* fileSystem.stat(gitPath).pipe(Effect.option);
    // Pult: an xaxis checkout, known by its marker (a file holding the checkout's id, as the
    // server's `XaxisVcsDriver` reads it), keeps state of its own as a linked worktree does. The
    // nearer of the marker and `.git` decides (`pult/decisions`, `vcs-detection-nearest`), and both
    // in one folder is refused.
    const xaxisMarker = yield* fileSystem
      .readFileString(path.join(directory, ".xaxis-checkout"))
      .pipe(Effect.orElseSucceed(() => ""));
    if (XAXIS_CHECKOUT_ID.test(xaxisMarker.trim())) {
      if (Option.isSome(info)) {
        return yield* Effect.die(
          new Error(
            `${directory} holds both .git and .xaxis-checkout; which one it is is unknown.`,
          ),
        );
      }
      return directory;
    }
    if (Option.isSome(info)) {
      if (info.value.type !== "File") {
        return undefined;
      }
      const contents = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      return pointsAtLinkedWorktree(contents, path) ? directory : undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
});

/**
 * Deliberately does not require the directory to exist yet: falling back
 * because it is missing would send callers at the shared home.
 */
export const resolveWorktreeT3Home = Effect.fn("devHome.resolveWorktreeT3Home")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const worktreePath = yield* resolveGitWorktreePath(cwd);
  if (worktreePath === undefined) {
    return undefined;
  }
  const path = yield* Path.Path;
  return path.join(worktreePath, ".t3");
});
