/**
 * The wrapper's preload, sandboxed: it exposes `window.pultDesktop`
 * (`bridge.ts`) and nothing else, the app's version handed over by main as an
 * `additionalArguments` entry.
 */
import { exposePultDesktop } from "./bridge.ts";
import { VERSION_ARG } from "./ipc.ts";

exposePultDesktop(
  process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "",
);
