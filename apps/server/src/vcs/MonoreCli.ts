// Pult: the `monore` CLI's boundary. It runs on its own login and a checkout's own server,
// the server's environment passed through untouched; every JSON document is decoded
// against the Schemas pinned here at `format` 1, so a changed shape fails loud.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandError, type VcsError } from "@t3tools/contracts";

import * as VcsProcess from "./VcsProcess.ts";

/** The CLI's JSON format this server reads. */
const MONORE_JSON_FORMAT = 1;

/** How long a read may take; a keychain prompt that blocks a headless spawn ends here. */
const READ_TIMEOUT_MS = 30_000;
const READ_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** The exit status of a land that conflicted. */
const LAND_CONFLICT_EXIT = 2;

const Hash = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));

export const MonoreStatus = Schema.Struct({
  format: Schema.Literal(MONORE_JSON_FORMAT),
  dir: Schema.String,
  prefix: Schema.String,
  server: Schema.String,
  base: Hash,
  head: Hash,
  changes: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["added", "modified", "deleted"]),
    }),
  ),
  /** Bottom first; empty during a conflict, whose changesets wait in it. */
  stack: Schema.Array(Hash),
  conflict: Schema.NullOr(
    Schema.Struct({
      paths: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          reason: Schema.Literals(["markers", "binary", "edit-delete", "file-folder"]),
          markers: Schema.Boolean,
          side: Schema.NullOr(Schema.Literals(["mine", "main"])),
          unresolved: Schema.Boolean,
        }),
      ),
    }),
  ),
  /** The command that finishes a write that stopped partway: `monore goto`, `monore land` or `monore resolve`. */
  interrupted: Schema.NullOr(Schema.String),
});
export type MonoreStatus = typeof MonoreStatus.Type;

export const MonoreTip = Schema.Struct({
  format: Schema.Literal(MONORE_JSON_FORMAT),
  tip: Hash,
  base: Hash,
  /** The entries `log --from <tip>` shows above the base. */
  behind: Schema.Number,
});
export type MonoreTip = typeof MonoreTip.Type;

export const MonoreChangeset = Schema.Struct({
  hash: Hash,
  parents: Schema.Array(Hash),
  message: Schema.String,
  /** The record's one string, `Name <id>`. */
  author: Schema.String,
  date: Schema.String,
  landed: Schema.Boolean,
});
export type MonoreChangeset = typeof MonoreChangeset.Type;

export const MonoreLog = Schema.Struct({
  format: Schema.Literal(MONORE_JSON_FORMAT),
  /** Newest first: the stack and a conflict's changesets (`landed: false`), then main's line from the base. */
  changesets: Schema.Array(MonoreChangeset),
});
export type MonoreLog = typeof MonoreLog.Type;

export const MonoreCheckouts = Schema.Struct({
  format: Schema.Literal(MONORE_JSON_FORMAT),
  /** This machine's checkouts, after the registry prunes the ones whose folder is gone. */
  checkouts: Schema.Array(
    Schema.Struct({
      dir: Schema.String,
      /** The tree path it holds, `/` for the whole tree. */
      prefix: Schema.String.check(Schema.isPattern(/^\//)),
      server: Schema.String,
      /** Null where its state is missing or unreadable. */
      base: Schema.NullOr(Hash),
    }),
  ),
});
export type MonoreCheckout = (typeof MonoreCheckouts.Type)["checkouts"][number];

/** The CLI refused (exit 1): `error: <message> (<code>)` on stderr, a hint on the lines after. */
export class MonoreRefusal extends Schema.TaggedError<MonoreRefusal>()("MonoreRefusal", {
  operation: Schema.String,
  cwd: Schema.String,
  code: Schema.String,
  detail: Schema.String,
  hint: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return this.hint === null ? this.detail : `${this.detail} ${this.hint}`;
  }

  /** As the RPCs' error, the CLI's message and hint as they are, the refusal its cause for its code. */
  toCommandError(): GitCommandError {
    return new GitCommandError({
      operation: this.operation,
      command: "monore",
      cwd: this.cwd,
      exitCode: 1,
      detail: this.message,
      cause: this,
    });
  }
}

/** A land that conflicted (exit 2): nothing landed, and the checkout holds main with the changes merged. */
export class MonoreLandConflicted extends Schema.TaggedError<MonoreLandConflicted>()(
  "MonoreLandConflicted",
  { operation: Schema.String, cwd: Schema.String },
) {}

export type MonoreCliError = MonoreRefusal | GitCommandError;

const isRefusal = Schema.is(MonoreRefusal);

/** The CLI's code where `error` is a refusal it printed, as `toCommandError` keeps it. */
export function refusalCode(error: GitCommandError): string | null {
  return isRefusal(error.cause) ? error.cause.code : null;
}

/** The first `error: <message> (<code>)` line of a refusal, and what follows as its hint. */
function parseRefusal(
  stderr: string,
): { readonly code: string; readonly detail: string; readonly hint: string | null } | null {
  const lines = stderr.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => line.startsWith("error: "));
  if (at < 0) return null;
  const match = /^error: (.*) \(([a-z][a-z0-9-]*)\)$/.exec(lines[at]!);
  if (match === null) return null;
  const hint = lines
    .slice(at + 1)
    .join("\n")
    .trim();
  return { detail: match[1]!, code: match[2]!, hint: hint === "" ? null : hint };
}

export interface MonoreRunInput {
  readonly operation: string;
  /**
   * The checkout's root, its real path: the CLI reads paths relative to the directory it
   * runs in, and one checkout's commands run one at a time, keyed by it.
   */
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

export interface MonoreCli {
  /** One run's stdout; a refusal fails as `MonoreRefusal`. */
  readonly run: (
    input: MonoreRunInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, MonoreCliError>;
  /**
   * A write (`commit`, `goto`, `resolve`), never cut short, since a killed write is what
   * leaves a checkout interrupted.
   */
  readonly write: (
    input: MonoreRunInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, MonoreCliError>;
  /** `land`, a write as `write`'s are; a conflict fails as `MonoreLandConflicted`. */
  readonly land: (
    input: Omit<MonoreRunInput, "args">,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, MonoreCliError | MonoreLandConflicted>;
  /** One run's stdout decoded as a JSON document of `schema`. */
  readonly json: <S extends Schema.ConstraintDecoder<unknown>>(
    input: MonoreRunInput,
    schema: S,
  ) => Effect.Effect<S["Type"], MonoreCliError>;
  /** `checkouts --json`, run in `cwd`, any folder: the registry is the machine's, not a checkout's. */
  readonly checkouts: (
    input: Omit<MonoreRunInput, "args">,
  ) => Effect.Effect<ReadonlyArray<MonoreCheckout>, MonoreCliError>;
  /**
   * `checkout <prefix> <dir>` of `server`, at main's tip or at the changeset `at`, run in `cwd`:
   * a write as `write`'s are, one at a time per `dir` (absolute, new or empty).
   */
  readonly checkout: (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly server: string;
    readonly prefix: string;
    readonly dir: string;
    readonly at?: string;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, MonoreCliError>;
}

/** The CLI at `binaryPath`, empty for `monore` on PATH. */
export const make = (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  binaryPath: Effect.Effect<string>,
): MonoreCli => {
  const command = binaryPath.pipe(Effect.map((path) => (path === "" ? "monore" : path)));

  const commandError = (input: MonoreRunInput, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: `monore ${input.args[0] ?? ""}`.trim(),
      cwd: input.cwd,
      argumentCount: input.args.length,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const fromProcessError = (input: MonoreRunInput, binary: string) => (error: VcsError) =>
    error._tag === "VcsProcessSpawnError"
      ? commandError(
          input,
          `monore was not found at ${binary}; install it or set \`monoreBinaryPath\`.`,
          error,
        )
      : commandError(input, error.message, error);

  const spawn = Effect.fn("MonoreCli.spawn")(function* (
    input: MonoreRunInput,
    timeoutMs: number,
    checkout: string = input.cwd,
  ) {
    const binary = yield* command;
    return yield* vcsProcess
      .run({
        operation: input.operation,
        command: binary,
        args: input.args,
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs,
        maxOutputBytes: READ_MAX_OUTPUT_BYTES,
        // Every command holds the checkout's lock and refuses `checkout-busy` while another does.
        concurrency: { key: `monore:${checkout}`, limit: 1 },
      })
      .pipe(Effect.mapError(fromProcessError(input, binary)));
  });

  /** Exit 0 as the run's output, 1 as the refusal it prints, any other as a command error. */
  const settle = Effect.fn("MonoreCli.settle")(function* (
    input: MonoreRunInput,
    result: VcsProcess.VcsProcessOutput,
  ) {
    if (result.exitCode === 0) return result;
    const refusal = result.exitCode === 1 ? parseRefusal(result.stderr) : null;
    if (refusal !== null) {
      return yield* new MonoreRefusal({
        operation: input.operation,
        cwd: input.cwd,
        ...refusal,
      });
    }
    return yield* commandError(
      input,
      `monore exited with ${result.exitCode}: ${result.stderr.trim().split("\n", 1)[0] ?? ""}`,
    );
  });

  const run: MonoreCli["run"] = Effect.fn("MonoreCli.run")(function* (input) {
    return yield* settle(input, yield* spawn(input, READ_TIMEOUT_MS));
  });

  const write: MonoreCli["write"] = Effect.fn("MonoreCli.write")(function* (input) {
    return yield* settle(input, yield* spawn(input, Number.POSITIVE_INFINITY));
  });

  const land: MonoreCli["land"] = Effect.fn("MonoreCli.land")(function* (input) {
    const run = { ...input, args: ["land"] };
    const result = yield* spawn(run, Number.POSITIVE_INFINITY);
    if (result.exitCode === LAND_CONFLICT_EXIT) {
      return yield* new MonoreLandConflicted({ operation: input.operation, cwd: input.cwd });
    }
    return yield* settle(run, result);
  });

  const version = (input: MonoreRunInput) =>
    run({ ...input, operation: `${input.operation}.version`, args: ["--version"] }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orElseSucceed(() => "an unknown version"),
    );

  const json: MonoreCli["json"] = Effect.fn("MonoreCli.json")(function* (input, schema) {
    const result = yield* run(input);
    if (result.stdoutTruncated) {
      return yield* commandError(input, "monore's answer exceeds the response limit.");
    }
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      result.stdout.trim(),
    ).pipe(Effect.option);
    if (decoded._tag === "Some") return decoded.value;
    const [binary, named] = yield* Effect.all([command, version(input)]);
    return yield* commandError(
      input,
      `monore at ${binary} (${named}) answered \`${input.args.join(" ")}\` in a JSON other than format ${MONORE_JSON_FORMAT}; install a CLI of that format.`,
    );
  });

  const checkouts: MonoreCli["checkouts"] = (input) =>
    json({ ...input, args: ["checkouts", "--json"] }, MonoreCheckouts).pipe(
      Effect.map((listed) => listed.checkouts),
    );

  const checkout: MonoreCli["checkout"] = Effect.fn("MonoreCli.checkout")(function* (input) {
    const run = {
      operation: input.operation,
      cwd: input.cwd,
      args: [
        "checkout",
        "--server",
        input.server,
        ...(input.at === undefined ? [] : ["--at", input.at]),
        input.prefix,
        input.dir,
      ],
    };
    return yield* settle(run, yield* spawn(run, Number.POSITIVE_INFINITY, input.dir));
  });

  return { run, write, land, json, checkouts, checkout };
};
