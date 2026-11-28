import { assert, it, describe } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError } from "@t3tools/contracts";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as MonoreVcsDriver from "./MonoreVcsDriver.ts";
import type * as VcsWorkflow from "./VcsWorkflow.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (
    rootDir: string,
    calls: string[],
    // Pult: run before each answer, once the probe has read the disk.
    beforeAnswer: Effect.Effect<void> = Effect.void,
  ) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              yield* beforeAnswer;
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === DETECT_COMMAND) {
                return processOutput(
                  `true\n${repoDir}\n${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`,
                );
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Pult: the nearest of a registered kind's marker and `.git` decides (`vcs-detection-nearest`,
  // `vcs-driver-seam`).
  const CHECKOUT_ID = "c078d1e2-6c3d-421c-b76d-a859c655780a\n";

  it.effect("detects a registered kind's checkout, the nearest of its marker and .git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" }),
      );
      const monoreInGit = path.join(rootDir, "repo", "checkout");
      const gitInMonore = path.join(rootDir, "checkout", "repo");
      const both = path.join(rootDir, "both");
      yield* fs.makeDirectory(path.join(rootDir, "repo", ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(monoreInGit, "sub"), { recursive: true });
      yield* fs.writeFileString(path.join(monoreInGit, ".monore-checkout"), CHECKOUT_ID);
      yield* fs.makeDirectory(path.join(gitInMonore, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(rootDir, "checkout", ".monore-checkout"), CHECKOUT_ID);
      yield* fs.makeDirectory(path.join(both, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(both, ".monore-checkout"), CHECKOUT_ID);
      const calls: string[] = [];
      const probed = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      let beforeAnswer: Effect.Effect<void> = Effect.void;
      // Detection calls none of the kind's routed calls.
      const workflow = {} as VcsWorkflow.VcsWorkflow;
      const registration = {
        kind: "monore",
        marker: MonoreVcsDriver.MONORE_MARKER,
        driver: yield* MonoreVcsDriver.makeVcsDriver,
        workflow,
      } as const;
      const kindAt = (registry: VcsDriverRegistry.VcsDriverRegistry["Service"], cwd: string) =>
        Effect.map(registry.detect({ cwd }), (detected) => ({
          kind: detected?.kind,
          root: detected?.repository.rootPath,
          routed: detected?.workflow === workflow,
        }));

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        // Unregistered, a checkout is the repository around it, or none.
        assert.deepEqual(yield* kindAt(registry, path.join(monoreInGit, "sub")), {
          kind: "git",
          root: path.join(rootDir, "repo"),
          routed: false,
        });
        assert.equal(yield* registry.detect({ cwd: path.join(rootDir, "checkout") }), null);

        // A detection git is still answering as the kind registers is not kept either.
        beforeAnswer = Deferred.succeed(probed, undefined).pipe(
          Effect.andThen(Deferred.await(answer)),
        );
        const inFlight = yield* Effect.forkChild(registry.detect({ cwd: monoreInGit }));
        yield* Deferred.await(probed);
        const registered = yield* Scope.make();
        yield* registry.register(registration).pipe(Scope.provide(registered));
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(inFlight);
        assert.deepEqual(yield* kindAt(registry, monoreInGit), {
          kind: "monore",
          root: monoreInGit,
          routed: true,
        });

        calls.length = 0;
        assert.deepEqual(yield* kindAt(registry, path.join(monoreInGit, "sub")), {
          kind: "monore",
          root: monoreInGit,
          routed: true,
        });
        assert.equal(calls.length, 0, "a registered kind's checkout is detected without a process");
        assert.deepEqual(yield* kindAt(registry, gitInMonore), {
          kind: "git",
          root: gitInMonore,
          routed: false,
        });
        const error = yield* registry.detect({ cwd: both }).pipe(Effect.flip);
        assert.equal(error._tag, "VcsRepositoryDetectionError");

        const second = yield* Effect.scoped(registry.register(registration)).pipe(Effect.exit);
        assert.isTrue(Exit.hasDies(second), "a second registration of a kind is a defect");

        // The marker gone, the repository around it is found again.
        yield* fs.remove(path.join(monoreInGit, ".monore-checkout"));
        assert.equal((yield* registry.detect({ cwd: monoreInGit }))?.kind, "git");

        // Its scope closed, the kind is gone, and the checkout is none again.
        assert.equal(
          (yield* registry.detect({ cwd: path.join(rootDir, "checkout") }))?.kind,
          "monore",
        );
        yield* Scope.close(registered, Exit.void);
        assert.equal(yield* registry.detect({ cwd: path.join(rootDir, "checkout") }), null);
        assert.equal(
          (yield* registry.get("monore").pipe(Effect.flip))._tag,
          "VcsUnsupportedOperationError",
        );
      }).pipe(
        Effect.provide(
          makeDiskBackedLayer(
            rootDir,
            calls,
            Effect.suspend(() => beforeAnswer),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  const makeFailingLayer = (detectOutput: VcsProcess.VcsProcessOutput) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            normalizeGitArgs(input.args).join(" ") === DETECT_COMMAND
              ? Effect.succeed(detectOutput)
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 128,
                    detail: "fatal: bad config line 1 in file .git/config",
                  }),
                ),
        }),
      ),
    );

  it.effect("reads only a failed work-tree probe as no repository", () =>
    Effect.gen(function* () {
      const probeFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(
          makeFailingLayer({
            ...processOutput(""),
            exitCode: ChildProcessSpawner.ExitCode(128),
            stderr: "fatal: bad config line 1 in file .git/config",
          }),
        ),
      );
      assert.equal(probeFailure, null);

      // A newline in the root path makes detection ask for it again, and main surfaced that failure.
      const fallbackFailure = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(
        Effect.flatMap((registry) => registry.detect({ cwd: "/repo" })),
        Effect.provide(makeFailingLayer(processOutput("true\n/re\npo\n.git\n"))),
        Effect.flip,
      );
      assert.equal(fallbackFailure._tag, "VcsProcessExitError");
    }),
  );
});
