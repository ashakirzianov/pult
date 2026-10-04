import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as Electron from "electron";

import * as PultPayloadSlot from "@t3tools/shared/pult/payloadSlot";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { deployStagedBuild, rollBackBuild } from "./PayloadMenu.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "pult-payload-menu-" });
  const slotDir = path.join(home, "payload");
  const events: string[] = [];
  const window = {
    webContents: { reload: () => events.push("reload") },
  } as unknown as Electron.BrowserWindow;
  const layer = Layer.mergeAll(
    DesktopEnvironment.layer(environmentInput).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: home })),
      ),
    ),
    Layer.succeed(DesktopWindow.DesktopWindow, {
      ensureMain: Effect.succeed(window),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
    Layer.succeed(ElectronDialog.ElectronDialog, {
      showMessageBox: (options: Electron.MessageBoxOptions) =>
        Effect.sync(() => {
          events.push(`dialog: ${options.message}`);
          return { response: 0, checkboxChecked: false };
        }),
    } as unknown as ElectronDialog.ElectronDialog["Service"]),
  );
  const stage = (buildId: string) =>
    PultPayloadSlot.stagePayloadBuild(slotDir, buildId, (buildDir) =>
      fs.makeDirectory(path.join(buildDir, "client")),
    );
  const current = PultPayloadSlot.readPayloadSlot(slotDir).pipe(
    Effect.map((slot) => Option.getOrNull(slot.current)),
  );
  return { events, layer, stage, current };
});

describe("PayloadMenu", () => {
  it.effect("deploys the staged build into the window, and rolls it back", () =>
    Effect.gen(function* () {
      const { events, layer, stage, current } = yield* makeHarness;

      yield* deployStagedBuild.pipe(Effect.provide(layer));
      assert.deepStrictEqual(events, ["dialog: No build is staged."]);

      yield* stage("b1");
      yield* deployStagedBuild.pipe(Effect.provide(layer));
      assert.strictEqual(yield* current, "b1");
      yield* deployStagedBuild.pipe(Effect.provide(layer));
      assert.deepStrictEqual(events.slice(1), ["reload"]);

      yield* stage("b2");
      yield* deployStagedBuild.pipe(Effect.provide(layer));
      yield* rollBackBuild.pipe(Effect.provide(layer));
      assert.strictEqual(yield* current, "b1");
      assert.deepStrictEqual(events.slice(1), ["reload", "reload", "reload"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
