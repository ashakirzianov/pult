import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("reads and writes synchronously what startup asks of it", () =>
    Effect.gen(function* () {
      const fileSystem = DesktopPreReadyFileSystem.make;
      const path = yield* Path.Path;
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-pre-ready-fs-",
      });
      const directory = path.join(root, "profile");
      yield* fileSystem.makeDirectory(directory);
      yield* fileSystem.writeFileString(path.join(directory, "Local State"), "keys");

      assert.isTrue(yield* fileSystem.exists(path.join(directory, "Local State")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, "missing")));
      assert.equal(yield* fileSystem.readFileString(path.join(directory, "Local State")), "keys");
    }),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(DesktopPreReadyFileSystem.make.exists(`${root}/profile`));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
