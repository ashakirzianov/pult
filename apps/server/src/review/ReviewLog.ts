// Pult: `review.getLog` and `review.getRefs`, a checkout's commit history and its
// refs for the shell's Source Control Graph (xaxis `pult/issues/scm-history`).
import * as Effect from "effect/Effect";

import {
  GitCommandError,
  type ReviewLogCommit,
  type ReviewLogInput,
  type ReviewLogResult,
  type ReviewRefsInput,
  type ReviewRefsResult,
} from "@t3tools/contracts";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const DEFAULT_LIMIT = 50;
/** A page whose messages outgrow this ends early, the commits read whole kept. */
const LOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const REFS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** The refs a commit is decorated with and `getRefs` lists; `refs/t3/` checkpoints and the stash are left out. */
const REF_NAMESPACES = ["refs/heads/", "refs/remotes/", "refs/tags/"] as const;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// sha, parents, author name, email and date, decorations, message: NUL after each, `-z` after the last.
const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%B";
const LOG_FIELDS = 7;

const logError = (cwd: string, detail: string) =>
  new GitCommandError({ operation: "ReviewLog.getLog", command: "git log", cwd, detail });

/** `%D` with `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`. */
export function parseDecorations(decorations: string): string[] {
  if (decorations.trim() === "") return [];
  return decorations
    .split(", ")
    .map((entry) => {
      const name = entry.trim();
      if (name.startsWith("HEAD -> ")) return name.slice("HEAD -> ".length);
      if (name.startsWith("tag: ")) return name.slice("tag: ".length);
      return name;
    })
    .filter((name) => REF_NAMESPACES.some((namespace) => name.startsWith(namespace)));
}

export const getLog = Effect.fn("ReviewLog.getLog")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  input: ReviewLogInput,
) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const refs = input.refs !== undefined && input.refs.length > 0 ? input.refs : undefined;
  if (refs === undefined) {
    const head = yield* git.execute({
      operation: "ReviewLog.getLog.head",
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD"],
      allowNonZeroExit: true,
    });
    // Before the first commit HEAD walks nothing, rather than failing.
    if (head.exitCode !== 0) return { commits: [], hasMore: false } satisfies ReviewLogResult;
  }
  const result = yield* git.execute({
    operation: "ReviewLog.getLog",
    cwd: input.cwd,
    args: [
      "log",
      "-z",
      "--no-notes",
      "--no-show-signature",
      "--topo-order",
      "--decorate=full",
      ...REF_NAMESPACES.map((namespace) => `--decorate-refs=${namespace}`),
      `--format=${LOG_FORMAT}`,
      `--skip=${input.skip ?? 0}`,
      `--max-count=${limit + 1}`,
      "--end-of-options",
      ...(refs ?? ["HEAD"]),
      "--",
    ],
    maxOutputBytes: LOG_MAX_OUTPUT_BYTES,
  });
  const fields = result.stdout.split("\0");
  // The last field is what follows the last NUL: empty when the output is whole, a cut record's start when not.
  if (!result.stdoutTruncated && fields.at(-1) !== "")
    return yield* logError(input.cwd, "Could not read the commit log.");
  const complete = Math.floor((fields.length - 1) / LOG_FIELDS);
  const commits: ReviewLogCommit[] = [];
  for (let record = 0; record < complete && commits.length <= limit; record++) {
    const at = record * LOG_FIELDS;
    const [sha, parents, authorName, authorEmail, authoredAt, decorations, message] = fields
      .slice(at, at + LOG_FIELDS)
      // `-z` puts a commit's NUL before the next record's sha, after the previous one's message newline.
      .map((field, index) => (index === 0 ? field.replace(/^\n/, "") : field));
    if (sha === undefined || !SHA.test(sha) || message === undefined)
      return yield* logError(input.cwd, "Could not read the commit log.");
    const text = message.replace(/\n+$/, "");
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
      subject: text.split("\n", 1)[0] ?? "",
      message: text,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authoredAt: authoredAt ?? "",
      refs: parseDecorations(decorations ?? ""),
    });
  }
  if (result.stdoutTruncated && commits.length === 0)
    return yield* logError(input.cwd, "A commit's message exceeds the response limit.");
  return {
    commits: commits.slice(0, limit),
    hasMore: result.stdoutTruncated || commits.length > limit,
  } satisfies ReviewLogResult;
});

export const getRefs = Effect.fn("ReviewLog.getRefs")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  input: ReviewRefsInput,
) {
  const { cwd } = input;
  const [symbolic, head, listed] = yield* Effect.all(
    [
      git.execute({
        operation: "ReviewLog.getRefs.symbolicHead",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      }),
      git.execute({
        operation: "ReviewLog.getRefs.head",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      }),
      git.execute({
        operation: "ReviewLog.getRefs",
        cwd,
        args: [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)",
          ...REF_NAMESPACES,
        ],
        maxOutputBytes: REFS_MAX_OUTPUT_BYTES,
      }),
    ],
    { concurrency: "unbounded" },
  );
  if (listed.stdoutTruncated)
    return yield* new GitCommandError({
      operation: "ReviewLog.getRefs",
      command: "git for-each-ref",
      cwd,
      detail: "The repository's refs exceed the response limit.",
    });
  const refs: Array<ReviewRefsResult["refs"][number]> = [];
  for (const line of listed.stdout.split("\n")) {
    if (line === "") continue;
    const [name, object, peeled, upstream, symref] = line.split("\0");
    if (name === undefined || symref !== "") continue;
    const sha = peeled || object;
    if (sha === undefined || !SHA.test(sha)) continue;
    refs.push({ name, sha, upstream: upstream || null });
  }
  return {
    head: {
      ref: symbolic.exitCode === 0 ? symbolic.stdout.trim() || null : null,
      sha: head.exitCode === 0 ? head.stdout.trim() || null : null,
    },
    refs,
  } satisfies ReviewRefsResult;
});
