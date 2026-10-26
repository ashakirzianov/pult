// @effect-diagnostics nodeBuiltinImport:off - FileSystem.watch cannot skip directories, and
// Node's recursive watcher on Linux otherwise walks every entry under the root.
/**
 * One OS watcher over a workspace tree: raw changes anywhere under a root,
 * never inside `.git` or `node_modules`. WorkspaceEntries shares one per root
 * between subscribers and turns its changes into batches.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

const isIgnoredPath = (relativePath: string) =>
  relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));

/**
 * Whether this Node honours `fs.watch`'s `ignore` option, which 24.14 and
 * 25.5 added. Older versions accept any value and drop it; newer ones reject
 * an invalid one.
 */
const honoursWatchIgnore = () => {
  try {
    // A variable, since @types/node does not declare `ignore` yet.
    const options = { persistent: false, ignore: 0 };
    NodeFS.watch(NodeOS.tmpdir(), options).close();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_TYPE";
  }
};

export class WorkspaceTreeWatchError extends Schema.TaggedError<WorkspaceTreeWatchError>()(
  "WorkspaceTreeWatchError",
  {
    root: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to watch the workspace tree at '${this.root}'.`;
  }
}

/**
 * A root-relative path with `/` separators, and whether the event said it
 * appeared, went away or moved rather than only changed.
 */
export interface WorkspaceTreeChange {
  readonly path: string;
  readonly rename: boolean;
}

export class WorkspaceTreeWatcher extends Context.Service<
  WorkspaceTreeWatcher,
  {
    /**
     * Raw changes under `root` from one OS watcher. Ends if the watcher
     * closes or the root itself goes away.
     */
    readonly watch: (root: string) => Stream.Stream<WorkspaceTreeChange, WorkspaceTreeWatchError>;
    /**
     * Whether the watcher walks `.git` and `node_modules` too, dropping only their
     * events: on Linux, where Node walks the tree itself, when this Node lacks `ignore`.
     * The server then leaves `projectWatchEntries` out of its config, so no client
     * starts a synchronous walk that takes an inotify watch per entry of a large tree.
     */
    readonly walksIgnoredDirectories: boolean;
  }
>()("t3/workspace/WorkspaceTreeWatcher") {}

const watch: WorkspaceTreeWatcher["Service"]["watch"] = (root) =>
  Stream.callback<WorkspaceTreeChange, WorkspaceTreeWatchError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          // FSEvents names the root by the basename of its real path.
          const rootName = NodePath.basename(NodeFS.realpathSync(root));
          // On Linux Node walks the tree here, synchronously, one inotify watch per
          // entry, stopping silently at the first error; `ignore` keeps it out of skipped
          // directories, while elsewhere it only filters events. Node before 24.14 and 25.5
          // drops the option (`walksIgnoredDirectories`), so events are filtered here too. A variable: @types/node lacks `ignore`.
          const options = { recursive: true, ignore: isIgnoredPath };
          const watcher = NodeFS.watch(root, options, (eventType, filename) => {
            if (filename === null || isIgnoredPath(filename)) return;
            // The root's own events: on macOS a change to the root and its deletion or
            // move arrive as `change` naming its basename, as an edit to a child of that
            // name can; on Linux the root's deletion arrives as `""`. Once the root is gone
            // nothing is left to watch; while it stands, the name is reported only if a child has it.
            if (filename === "" || (eventType === "change" && filename === rootName)) {
              if (!NodeFS.existsSync(root)) {
                Queue.endUnsafe(queue);
                return;
              }
              const isChild =
                filename !== "" &&
                NodeFS.lstatSync(NodePath.join(root, filename), { throwIfNoEntry: false }) !==
                  undefined;
              if (!isChild) return;
            }
            Queue.offerUnsafe(queue, {
              path: filename.split(NodePath.sep).join("/"),
              rename: eventType === "rename",
            });
          });
          watcher.on("error", (cause) =>
            Queue.failCauseUnsafe(queue, Cause.fail(new WorkspaceTreeWatchError({ root, cause }))),
          );
          watcher.on("close", () => Queue.endUnsafe(queue));
          return watcher;
        },
        catch: (cause) => new WorkspaceTreeWatchError({ root, cause }),
      }),
      (watcher) => Effect.sync(() => watcher.close()),
    ).pipe(
      // Stream.callback does not fail the stream when this effect fails.
      Effect.catchTags({ WorkspaceTreeWatchError: (error) => Queue.fail(queue, error) }),
    ),
  );

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const walksIgnoredDirectories = platform === "linux" && !(yield* Effect.sync(honoursWatchIgnore));
  return WorkspaceTreeWatcher.of({ watch, walksIgnoredDirectories });
});

export const layer = Layer.effect(WorkspaceTreeWatcher, make);
