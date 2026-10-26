/**
 * `pnpm desktop:dev`: builds main and the preload, then runs Electron on them
 * under the dev identity, on the page at http://localhost:5190, or the one
 * `PULT_DEV_SERVER_URL` names. A loopback page nobody serves yet gets the
 * repo's Vite dev server started here, on that port, and stopped with
 * Electron; a server already up (a `pnpm dev` of yours) is used as it is.
 * Exits with Electron.
 */
import * as NodeChildProcess from "node:child_process";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

import { build } from "./build.ts";

const desktopDir = NodePath.dirname(import.meta.dirname);
const repoRoot = NodePath.dirname(desktopDir);
// Required from Node, the `electron` package is the path of its binary.
const electronPath: string = createRequire(import.meta.url)("electron");
const pageUrl = new URL(process.env.PULT_DEV_SERVER_URL || "http://localhost:5190");
const READY_TIMEOUT_MS = 60_000;

// An agent's shell may carry ELECTRON_RUN_AS_NODE=1, which turns `electron` into a bare Node.
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

await build();
const server = (await answers(pageUrl)) ? undefined : startDevServer();
if (server !== undefined) await ready(pageUrl, server);

const electron = NodeChildProcess.spawn(electronPath, ["."], { cwd: desktopDir, env, stdio: "inherit" });
// Ctrl+C stops the tree and is a clean exit, not a failure for pnpm to report.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    electron.kill(signal);
    stop(server);
  });
}
electron.on("exit", (code, signal) => {
  stop(server);
  process.exit(interrupted ? 0 : (code ?? (signal === null ? 0 : 1)));
});

/**
 * The repo's `vp dev` on the page's port, in its own process group so that
 * the whole tree, Vite's workers included, stops together. Output goes to
 * this terminal, as `pnpm dev`'s would.
 */
function startDevServer(): NodeChildProcess.ChildProcess {
  if (pageUrl.protocol !== "http:") {
    throw new Error(`Nothing answers at ${pageUrl.href}, and only a loopback http:// page is served from here.`);
  }
  const port = pageUrl.port === "" ? "80" : pageUrl.port;
  console.info(`[pult-desktop] nothing answers at ${pageUrl.href}; starting the dev server on port ${port}.`);
  const vp = NodePath.join(repoRoot, "node_modules/.bin/vp");
  return NodeChildProcess.spawn(vp, ["dev", "--port", port], { cwd: repoRoot, env, stdio: "inherit", detached: true });
}

function stop(server: NodeChildProcess.ChildProcess | undefined): void {
  if (server === undefined || server.pid === undefined || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** Whether something answers at the page's URL, whatever it says. */
async function answers(url: URL): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Waits for the server just started to answer; its early exit, or a minute, is an error. */
async function ready(url: URL, server: NodeChildProcess.ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The dev server exited with code ${server.exitCode} before it answered.`);
    if (await answers(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop(server);
  throw new Error(`The dev server did not answer at ${url.href} within ${READY_TIMEOUT_MS / 1000} s.`);
}
