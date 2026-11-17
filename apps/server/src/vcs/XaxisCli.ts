// Pult: the `xaxis` CLI's boundary. It runs on its own login and a checkout's own server,
// the server's environment passed through untouched; every JSON document is decoded
// against the Schemas pinned here at `format` 1, so a changed shape fails loud.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitCommandError, type VcsError } from "@t3tools/contracts";

import * as VcsProcess from "./VcsProcess.ts";

/** The CLI's JSON format this server reads. */
const XAXIS_JSON_FORMAT = 1;

/** How long a read may take; a keychain prompt that blocks a headless spawn ends here. */
const READ_TIMEOUT_MS = 30_000;
const READ_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const Hash = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));

export const XaxisStatus = Schema.Struct({
  format: Schema.Literal(XAXIS_JSON_FORMAT),
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
  /** The command that finishes a write that stopped partway: `xaxis goto`, `xaxis land` or `xaxis resolve`. */
  interrupted: Schema.NullOr(Schema.String),
});
export type XaxisStatus = typeof XaxisStatus.Type;

export const XaxisTip = Schema.Struct({
  format: Schema.Literal(XAXIS_JSON_FORMAT),
  tip: Hash,
  base: Hash,
  /** The entries `log --from <tip>` shows above the base. */
  behind: Schema.Number,
});
export type XaxisTip = typeof XaxisTip.Type;

export const XaxisChangeset = Schema.Struct({
  hash: Hash,
  parents: Schema.Array(Hash),
  message: Schema.String,
  /** The record's one string, `Name <id>`. */
  author: Schema.String,
  date: Schema.String,
  landed: Schema.Boolean,
});
export type XaxisChangeset = typeof XaxisChangeset.Type;

export const XaxisLog = Schema.Struct({
  format: Schema.Literal(XAXIS_JSON_FORMAT),
  /** Newest first: the stack and a conflict's changesets (`landed: false`), then main's line from the base. */
  changesets: Schema.Array(XaxisChangeset),
});
export type XaxisLog = typeof XaxisLog.Type;

/** The CLI refused (exit 1): `error: <message> (<code>)` on stderr, a hint on the lines after. */
export class XaxisRefusal extends Schema.TaggedError<XaxisRefusal>()("XaxisRefusal", {
  operation: Schema.String,
  cwd: Schema.String,
  code: Schema.String,
  detail: Schema.String,
  hint: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return this.hint === null ? this.detail : `${this.detail} ${this.hint}`;
  }

  /** As the RPCs' error, the CLI's message and hint as they are. */
  toCommandError(): GitCommandError {
    return new GitCommandError({
      operation: this.operation,
      command: "xaxis",
      cwd: this.cwd,
      exitCode: 1,
      detail: this.message,
    });
  }
}

export type XaxisCliError = XaxisRefusal | GitCommandError;

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

export interface XaxisRunInput {
  readonly operation: string;
  /**
   * The checkout's root, its real path: the CLI reads paths relative to the directory it
   * runs in, and one checkout's commands run one at a time, keyed by it.
   */
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

export interface XaxisCli {
  /** One run's stdout; a refusal fails as `XaxisRefusal`. */
  readonly run: (input: XaxisRunInput) => Effect.Effect<VcsProcess.VcsProcessOutput, XaxisCliError>;
  /** One run's stdout decoded as a JSON document of `schema`. */
  readonly json: <S extends Schema.ConstraintDecoder<unknown>>(
    input: XaxisRunInput,
    schema: S,
  ) => Effect.Effect<S["Type"], XaxisCliError>;
}

/** The CLI at `binaryPath`, empty for `xaxis` on PATH. */
export const make = (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  binaryPath: Effect.Effect<string>,
): XaxisCli => {
  const command = binaryPath.pipe(Effect.map((path) => (path === "" ? "xaxis" : path)));

  const commandError = (input: XaxisRunInput, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: `xaxis ${input.args[0] ?? ""}`.trim(),
      cwd: input.cwd,
      argumentCount: input.args.length,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const fromProcessError = (input: XaxisRunInput, binary: string) => (error: VcsError) =>
    error._tag === "VcsProcessSpawnError"
      ? commandError(
          input,
          `xaxis was not found at ${binary}; install it or set \`xaxisBinaryPath\`.`,
          error,
        )
      : commandError(input, error.message, error);

  const run: XaxisCli["run"] = Effect.fn("XaxisCli.run")(function* (input) {
    const binary = yield* command;
    const result = yield* vcsProcess
      .run({
        operation: input.operation,
        command: binary,
        args: input.args,
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs: READ_TIMEOUT_MS,
        maxOutputBytes: READ_MAX_OUTPUT_BYTES,
        // Every command holds the checkout's lock and refuses `checkout-busy` while another does.
        concurrency: { key: `xaxis:${input.cwd}`, limit: 1 },
      })
      .pipe(Effect.mapError(fromProcessError(input, binary)));
    if (result.exitCode === 0) return result;
    const refusal = result.exitCode === 1 ? parseRefusal(result.stderr) : null;
    if (refusal !== null) {
      return yield* new XaxisRefusal({
        operation: input.operation,
        cwd: input.cwd,
        ...refusal,
      });
    }
    return yield* commandError(
      input,
      `xaxis exited with ${result.exitCode}: ${result.stderr.trim().split("\n", 1)[0] ?? ""}`,
    );
  });

  const version = (input: XaxisRunInput) =>
    run({ ...input, operation: `${input.operation}.version`, args: ["--version"] }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.orElseSucceed(() => "an unknown version"),
    );

  const json: XaxisCli["json"] = Effect.fn("XaxisCli.json")(function* (input, schema) {
    const result = yield* run(input);
    if (result.stdoutTruncated) {
      return yield* commandError(input, "xaxis's answer exceeds the response limit.");
    }
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      result.stdout.trim(),
    ).pipe(Effect.option);
    if (decoded._tag === "Some") return decoded.value;
    const [binary, named] = yield* Effect.all([command, version(input)]);
    return yield* commandError(
      input,
      `xaxis at ${binary} (${named}) answered \`${input.args.join(" ")}\` in a JSON other than format ${XAXIS_JSON_FORMAT}; install a CLI of that format.`,
    );
  });

  return { run, json };
};
