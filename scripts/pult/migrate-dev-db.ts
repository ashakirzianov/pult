#!/usr/bin/env node
// Seeds this checkout's dev database from a pruned, read-only snapshot of
// ~/.t3, with the migrate-dev-db script of the T3 Code Extensible checkout
// (PULT_T3CODE_CHECKOUT), since the server that owns the schema lives there.
// The target is this checkout's own .t3, the home the dev runner gives the server.
//
//   vp run migrate-dev-db [--base-dir <dir>] [--projects <n>] [--threads-per-project <n>]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArguments, HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/process";

import { DEV_T3_HOME, T3CODE_CHECKOUT_VARIABLE, t3codeCheckoutPath } from "./checkout.ts";

const MIGRATE_SCRIPT = "apps/server/scripts/migrate-dev-db.ts";

export class MigrateDevDbError extends Schema.TaggedError<MigrateDevDbError>()(
  "MigrateDevDbError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The checkout script's arguments: `home` as --base-dir, unless one was given. */
export function migrateArgs(args: ReadonlyArray<string>, home: string): ReadonlyArray<string> {
  if (args.some((arg) => arg === "--base-dir" || arg.startsWith("--base-dir="))) return args;
  return ["--base-dir", home, ...args];
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = t3codeCheckoutPath();
  const script = path.join(checkout, MIGRATE_SCRIPT);
  if (!(yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new MigrateDevDbError({
      detail: `No ${MIGRATE_SCRIPT} in ${checkout}. Set ${T3CODE_CHECKOUT_VARIABLE}, in the environment or .env, to a T3 Code Extensible checkout with its dependencies installed.`,
    });
  }

  const args = migrateArgs((yield* HostProcessArguments).slice(2), DEV_T3_HOME);

  const child = yield* ChildProcess.make(yield* HostProcessExecutablePath, [script, ...args], {
    cwd: checkout,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new MigrateDevDbError({
      detail: `${MIGRATE_SCRIPT} exited with code ${exitCode}.`,
    });
  }
});

if (import.meta.main) {
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
