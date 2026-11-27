// A watcher's command (monore `pult/tasks/star-watcher-scripts.task`): a schedule's `run`, run with
// `sh -c` in its Star's folder with the server's environment, for a minute at most and 64 KiB of
// output. Only what it printed decides whether the Star hears of it; stderr goes into a failure.
import { Effect, ProcessRunner } from "../host.ts";

const MAX_OUTPUT_BYTES = 65_536;
const STDERR_LINES = 20;

export type CommandOutcome =
  /** Exit 0 with something on stdout, as printed. */
  | { readonly kind: "printed"; readonly output: string }
  /** Exit 0 with stdout blank: nobody is told. */
  | { readonly kind: "silent" }
  | { readonly kind: "failed"; readonly error: string };

export type RunCommand = (root: string, command: string) => Effect.Effect<CommandOutcome>;

const withStderr = (head: string, stderr: string) => {
  const tail = stderr.trimEnd().split(/\r?\n/).slice(-STDERR_LINES).join("\n");
  return tail.trim() === "" ? head : `${head}\n${tail}`;
};

export const runCommand = Effect.fn("Schedules.runCommand")(function* (
  root: string,
  command: string,
  /** In milliseconds. */
  limit = 60_000,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* runner
    .run({
      command: "/bin/sh",
      args: ["-c", command],
      cwd: root,
      timeout: limit,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: MAX_OUTPUT_BYTES,
      // Not "error", which would fail a run on too much stderr: stderr decides nothing.
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((result): CommandOutcome => {
        if (result.timedOut)
          return {
            kind: "failed",
            error: `timed out after ${limit / 1000}s`,
          };
        if (result.stdoutTruncated) return { kind: "failed", error: "printed more than 64 KiB" };
        if (result.code !== 0)
          return {
            kind: "failed",
            error: withStderr(`exited ${String(result.code)}`, result.stderr),
          };
        return result.stdout.trim() === ""
          ? { kind: "silent" }
          : { kind: "printed", output: result.stdout };
      }),
      Effect.catch((error) =>
        Effect.succeed<CommandOutcome>({ kind: "failed", error: error.message }),
      ),
    );
});
