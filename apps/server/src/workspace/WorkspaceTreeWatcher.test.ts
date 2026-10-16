// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import type { ProjectEntryChange, ProjectWatchEntriesEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceTreeWatcher from "./WorkspaceTreeWatcher.ts";

// The real fs.watch, recording each watcher it opens with a promise of its
// closing, which a test can make drop `ignore` as Node before 24.14 does.
const fsWatch = vi.hoisted(() => ({
  dropsIgnore: false,
  opened: [] as Array<{ readonly path: string; readonly closed: Promise<void> }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = (
    path: string,
    options: NodeFS.WatchOptionsWithStringEncoding & { readonly ignore?: unknown },
    listener?: NodeFS.WatchListener<string>,
  ) => {
    const { ignore: _ignore, ...withoutIgnore } = options;
    const watcher = actual.watch(path, fsWatch.dropsIgnore ? withoutIgnore : options, listener);
    const closed = new Promise<void>((resolve) => watcher.once("close", () => resolve()));
    fsWatch.opened.push({ path, closed });
    return watcher;
  };
  return { ...actual, watch };
});

// WorkspaceEntries over the real OS watcher.
const layerTest = WorkspaceEntries.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-tree-watcher-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeRoot = Effect.fn(function* (name = "proj") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-tree-watcher-" }),
    name,
  );
  yield* fileSystem.makeDirectory(root);
  return root;
});

const writeFile = Effect.fn(function* (root: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, relativePath);
});

// Takes batches until one names `path`, returning every change taken.
const takeUntil = Effect.fn(function* (
  batches: Queue.Dequeue<ProjectWatchEntriesEvent>,
  path: string,
) {
  const taken: Array<ProjectEntryChange> = [];
  for (;;) {
    const { changes } = yield* Queue.take(batches);
    taken.push(...changes);
    if (changes.some((change) => change.path === path)) return taken;
  }
});

// Watches `root` in the background and returns once it reports changes. On
// macOS the OS watcher starts after fs.watch returns and nothing says when,
// so a write made at once can be lost: a probe is rewritten until reported.
const startWatch = Effect.fn(function* (root: string) {
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const batches = yield* Queue.unbounded<ProjectWatchEntriesEvent>();
  const fiber = yield* workspaceEntries.watch({ cwd: root }).pipe(
    Stream.runForEach((batch) => Queue.offer(batches, batch)),
    Effect.forkScoped,
  );
  yield* Effect.race(
    takeUntil(batches, "probe.txt"),
    writeFile(root, "probe.txt").pipe(Effect.repeat(Schedule.spaced("50 millis")), Effect.orDie),
  );
  return { batches, fiber };
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceTreeWatcher", (it) => {
  describe("walksIgnoredDirectories", () => {
    it.effect("is set on Linux only, when Node drops `ignore`", () =>
      Effect.gen(function* () {
        const walksOn = (platform: NodeJS.Platform) =>
          Effect.map(
            WorkspaceTreeWatcher.WorkspaceTreeWatcher,
            (treeWatcher) => treeWatcher.walksIgnoredDirectories,
          ).pipe(
            Effect.provide(Layer.fresh(WorkspaceTreeWatcher.layer)),
            Effect.provideService(HostProcess.Platform, platform),
          );
        fsWatch.dropsIgnore = true;
        const walks = yield* Effect.all([walksOn("linux"), walksOn("darwin")]).pipe(
          Effect.ensuring(Effect.sync(() => (fsWatch.dropsIgnore = false))),
        );
        expect(walks).toEqual([true, false]);
      }),
    );
  });

  describe("watch", () => {
    it.effect("reports changes beside node_modules and none inside it", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot();
        yield* writeFile(root, "node_modules/pkg/index.js");
        const { batches } = yield* startWatch(root);

        yield* writeFile(root, "node_modules/pkg/index.js");
        yield* writeFile(root, "node_modules/pkg/added.js");
        yield* writeFile(root, "src.txt");
        const changes = yield* takeUntil(batches, "src.txt");
        expect(changes.filter((change) => change.path.includes("node_modules"))).toEqual([]);
      }),
    );

    it.effect("shares one OS watcher and closes it when its last subscriber leaves", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot();
        const first = yield* startWatch(root);
        const second = yield* startWatch(root);
        const opened = fsWatch.opened.filter((watcher) => watcher.path === root);
        expect(opened).toHaveLength(1);

        yield* Fiber.interrupt(first.fiber);
        yield* writeFile(root, "after.txt");
        yield* takeUntil(second.batches, "after.txt");

        yield* Fiber.interrupt(second.fiber);
        yield* Effect.promise(() => opened[0]!.closed);
      }),
    );

    it.effect("drops the root's own changes and fails once the root is gone", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeRoot("proj");
        const { batches, fiber } = yield* startWatch(root);

        // macOS names a change to the root itself by the root's basename.
        yield* fileSystem.utimes(root, 0, 0);
        yield* writeFile(root, "after.txt");
        const changes = yield* takeUntil(batches, "after.txt");
        expect(changes.filter((change) => change.path === "proj")).toEqual([]);

        yield* fileSystem.remove(root, { recursive: true });
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceRootNotExistsError");
      }),
    );
  });
});
