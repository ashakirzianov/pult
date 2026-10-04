#!/usr/bin/env node
// Builds the client and stages it in Pult's payload slot (DECISIONS.md,
// `payload-slot`). It never makes a build live: the human does that from the
// desktop app, View → Deploy Staged Build.
//
//   vp run pult:stage [--base-dir <home>]
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PultPayloadSlot from "@t3tools/shared/pult/payloadSlot";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { applyWebBrandAssets } from "../apply-web-brand-assets.ts";

export class StageClientError extends Schema.TaggedError<StageClientError>()("StageClientError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "../..");
});

// Same rule as the server's: an explicit home wins, otherwise ~/.pult. An
// installed T3 Code's live home is refused even when named.
const resolveHome = Effect.fn("resolveHome")(function* (explicit: Option.Option<string>) {
  const path = yield* Path.Path;
  const userHome = NodeOS.homedir();
  const raw = Option.getOrUndefined(explicit)?.trim();
  const home = raw
    ? path.resolve(raw.replace(/^~(?=$|[/\\])/, userHome))
    : path.join(userHome, ".pult");
  if (home === path.join(userHome, ".t3")) {
    return yield* new StageClientError({
      detail: "Refusing to stage into ~/.t3, T3 Code's live home.",
    });
  }
  return home;
});

const run = Effect.fn("run")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* (yield* spawner.spawn(command)).exitCode;
  if (exitCode !== 0) {
    return yield* new StageClientError({
      detail: `${command.command} ${command.args.join(" ")} exited with code ${exitCode}.`,
    });
  }
});

// A sortable time, then the commit it was built from; `-dirty` when the
// worktree had uncommitted changes.
const makeBuildId = Effect.fn("makeBuildId")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (...args: string[]) =>
    spawner.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((out) => out.trim()));
  const sha = yield* git("rev-parse", "--short", "HEAD");
  const dirty = (yield* git("status", "--porcelain")).length > 0;
  const now = DateTime.formatIso(yield* DateTime.now).replace(/[-:]|\.\d+/g, "");
  return `${now}-${sha}${dirty ? "-dirty" : ""}`;
});

const stageClient = Command.make(
  "stage-client",
  {
    baseDir: Flag.String("base-dir").pipe(
      Flag.withDescription(
        "Pult home to stage into (equivalent to T3CODE_HOME); ~/.pult by default.",
      ),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* repoRoot;
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const home = yield* resolveHome(Option.orElse(flags.baseDir, () => envHome));
      const slotDir = yield* PultPayloadSlot.payloadSlotDir(home);
      const buildId = yield* makeBuildId(root);

      const build = yield* resolveSpawnCommand("vp", ["run", "--filter", "@pult/client", "build"]);
      yield* run(
        ChildProcess.make(build.command, build.args, {
          cwd: root,
          shell: build.shell,
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      const clientDist = path.join(root, "apps/pult/dist");
      if (!(yield* fs.exists(path.join(clientDist, "index.html")))) {
        return yield* new StageClientError({
          detail: `The build left no index.html in ${clientDist}.`,
        });
      }
      // The build carries the dev icons from public/; a staged client is a prod one.
      yield* applyWebBrandAssets("production", "apps/pult/dist");

      const buildDir = yield* PultPayloadSlot.stagePayloadBuild(slotDir, buildId, (dir) =>
        fs.copy(clientDist, path.join(dir, "client")),
      );
      yield* Effect.log(
        `Staged build ${buildId} at ${buildDir}. Deploy it from the desktop app: View → Deploy Staged Build.`,
      );
    }),
).pipe(Command.withDescription("Build the client and stage it in Pult's payload slot."));

if (import.meta.main) {
  Command.run(stageClient, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
