/**
 * `pnpm desktop:dev`: builds main and the preload, then runs Electron on them
 * under the dev identity, on the page of a running `pnpm dev`
 * (http://localhost:5190, or `PULT_DEV_SERVER_URL`). Exits with Electron.
 */
import * as NodeChildProcess from "node:child_process";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

import { build } from "./build.ts";

const desktopDir = NodePath.dirname(import.meta.dirname);
// Required from Node, the `electron` package is the path of its binary.
const electronPath: string = createRequire(import.meta.url)("electron");

await build();

// An agent's shell may carry ELECTRON_RUN_AS_NODE=1, which turns `electron` into a bare Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
const child = NodeChildProcess.spawn(electronPath, ["."], { cwd: desktopDir, env, stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
