// Pult's switch for the payload slot (`@t3tools/shared/pult/payloadSlot`).
// Agents only stage builds; switching one live reloads the human's window,
// so it lives here, in the shell's menu, where only the human reaches it.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as Electron from "electron";

import * as PultPayloadSlot from "@t3tools/shared/pult/payloadSlot";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const { logInfo, logError } = makeComponentLogger("pult-payload");

const reloadMainWindow = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const window = yield* desktopWindow.ensureMain;
  window.webContents.reload();
});

const reportSlotError = (error: PultPayloadSlot.PayloadSlotError) =>
  Effect.gen(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;
    yield* dialog.showMessageBox({
      type: "info",
      title: "Nothing to switch",
      message: error.message,
      buttons: ["OK"],
    });
  });

const slotDir = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return yield* PultPayloadSlot.payloadSlotDir(environment.baseDir);
});

/** Makes the staged build live and reloads the window onto it. */
export const deployStagedBuild = Effect.gen(function* () {
  const dir = yield* slotDir;
  const deployed = yield* PultPayloadSlot.deployStagedPayload(dir);
  const slot = yield* PultPayloadSlot.readPayloadSlot(dir);
  yield* logInfo("deploy staged build", {
    deployed,
    current: slot.current,
    previous: slot.previous,
  });
  if (deployed) yield* reloadMainWindow;
}).pipe(
  Effect.catchTag("PayloadSlotError", reportSlotError),
  Effect.withSpan("desktop.pult.deployStagedBuild"),
);

/** Makes the previous build live again and reloads the window onto it. */
export const rollBackBuild = Effect.gen(function* () {
  const dir = yield* slotDir;
  yield* PultPayloadSlot.rollBackPayload(dir);
  const slot = yield* PultPayloadSlot.readPayloadSlot(dir);
  yield* logInfo("roll back build", { current: slot.current, previous: slot.previous });
  yield* reloadMainWindow;
}).pipe(
  Effect.catchTag("PayloadSlotError", reportSlotError),
  Effect.withSpan("desktop.pult.rollBackBuild"),
);

type PayloadMenuServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog
  | FileSystem.FileSystem
  | Path.Path;

/**
 * The View menu's items for the slot. None in development, where the window
 * loads from Vite and a switch would change nothing on screen.
 */
export const makePayloadMenuItems = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (environment.isDevelopment) return items;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<PayloadMenuServices>());
  const click =
    <E>(action: string, effect: Effect.Effect<void, E, PayloadMenuServices>) =>
    () => {
      void runPromise(
        effect.pipe(Effect.catchCause((cause) => logError(`${action} failed`, { cause }))),
      );
    };
  items.push(
    { type: "separator" },
    { label: "Deploy Staged Build", click: click("deploy staged build", deployStagedBuild) },
    { label: "Roll Back Build", click: click("roll back build", rollBackBuild) },
  );
  return items;
});
