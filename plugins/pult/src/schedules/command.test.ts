import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import { Effect, FileSystem, Layer, ProcessRunner } from "../host.ts";
import { runCommand } from "./command.ts";

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** The command run in a fresh temporary folder, with the real shell. */
const run = (command: string, limit?: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    // macOS's temporary folders are behind a symlink, which `pwd -P` resolves.
    return { real: yield* fs.realPath(root), outcome: yield* runCommand(root, command, limit) };
  }).pipe(Effect.scoped, Effect.provide(layer));

describe("runCommand", () => {
  it.effect("is what it printed, as printed", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run("printf 'new mail\\n\\n'; echo noise >&2");
      assert.deepStrictEqual(outcome, { kind: "printed", output: "new mail\n\n" });
    }),
  );

  it.effect("is silent when it printed whitespace only", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run("printf ' \\n\\t\\n'; echo noise >&2");
      assert.deepStrictEqual(outcome, { kind: "silent" });
    }),
  );

  it.effect("fails on a non-zero exit, with the last 20 lines of stderr", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run(
        "echo printed; for i in $(seq 1 25); do echo line $i >&2; done; exit 2",
      );
      const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 6}`);
      assert.deepStrictEqual(outcome, {
        kind: "failed",
        error: ["exited 2", ...lines].join("\n"),
      });
    }),
  );

  it.effect("runs in the folder it is given", () =>
    Effect.gen(function* () {
      const { real, outcome } = yield* run("pwd -P");
      assert.deepStrictEqual(outcome, { kind: "printed", output: `${real}\n` });
    }),
  );

  it.effect("fails when it printed more than 64 KiB", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run("head -c 65537 /dev/zero | tr '\\0' a");
      assert.deepStrictEqual(outcome, { kind: "failed", error: "printed more than 64 KiB" });
    }),
  );

  it.live("fails when it runs out of time", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run("sleep 5", 1000);
      assert.deepStrictEqual(outcome, { kind: "failed", error: "timed out after 1s" });
    }),
  );
});
