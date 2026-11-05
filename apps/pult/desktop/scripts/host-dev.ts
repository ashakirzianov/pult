/**
 * `pnpm desktop:host`: Pult.app in development, upstream's desktop app
 * (`apps/desktop`) built under Pult's brand (`src/brand.ts`) as "Pult Host
 * (Dev)", on the shell's page from Vite on `PULT_PAGE_PORT` (5194), its local
 * server the built `apps/server` on `T3CODE_PORT` (3794) with its home in the
 * checkout's `.t3` (`T3CODE_HOME`). Upstream's own launcher is not used: on
 * macOS it registers a dev app bundle as its scheme's handler.
 *
 *   node apps/pult/desktop/scripts/host-dev.ts [--local-server=on|off] [--devtools]
 *     [-- <Electron arguments, e.g. --remote-debugging-port=9334>]
 *
 * `--local-server` writes upstream's setting into the home's
 * `userdata/desktop-settings.json` before the launch; off, the app starts no
 * server. `--devtools` opens DevTools detached, as upstream's development
 * does. The app's relaunch (exit 75, after the setting changes in the page)
 * starts Electron again. Each child runs in a process group of its own; Ctrl+C
 * or Electron's exit stops both.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const root = NodePath.resolve(import.meta.dirname, "../../../..");
const desktopDir = NodePath.join(root, "apps/desktop");
const pageDir = NodePath.join(root, "apps/pult");
const vp = NodePath.join(root, "node_modules/.bin/vp");
const pagePort = Number(process.env.PULT_PAGE_PORT ?? 5194);
const serverPort = Number(process.env.T3CODE_PORT ?? 3794);
const home = NodePath.resolve(process.env.T3CODE_HOME ?? NodePath.join(root, ".t3"));
/** Upstream's development relaunch: the app exits with this code and its launcher starts it again. */
const RELAUNCH_EXIT_CODE = 75;

const { values: flags, positionals: electronArgs } = NodeUtil.parseArgs({
  options: { "local-server": { type: "string" }, devtools: { type: "boolean", default: false } },
  allowPositionals: true,
});

// The installed app's server and its data are never this run's.
if (serverPort === 3773) fail("T3CODE_PORT 3773 is the installed app's server; pick another.");
if (home === NodePath.join(NodeOS.homedir(), ".t3"))
  fail("T3CODE_HOME is the live ~/.t3; use the checkout's .t3 or another directory.");
if (flags["local-server"] !== undefined) setLocalServer(flags["local-server"]);
if (!NodeFS.existsSync(NodePath.join(root, "apps/server/dist/bin.mjs")))
  fail("apps/server/dist/bin.mjs is missing: run `vp pack` in apps/server.");
for (const port of [pagePort, serverPort])
  if (await answers(port)) fail(`Port ${port} is taken; set PULT_PAGE_PORT or T3CODE_PORT.`);

const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;

console.log("[host-dev] building upstream's main and preload under Pult's brand");
for (const [command, args] of [
  ["node", ["scripts/build-browser-secret.mjs"]],
  ["node", ["scripts/build-preview-annotation-css.mjs"]],
  [vp, ["pack"]],
] as const) {
  const built = NodeChildProcess.spawnSync(command, args, {
    cwd: desktopDir,
    env: { ...env, T3CODE_DESKTOP_BRAND: "apps/pult/desktop/src/brand.ts" },
    stdio: "inherit",
  });
  if (built.status !== 0) fail(`${command} ${args.join(" ")} failed.`);
}
console.log(`[host-dev] page :${pagePort}, server :${serverPort}, home ${home}`);

const vite = NodeChildProcess.spawn(vp, ["dev", "--port", String(pagePort), "--strictPort"], {
  cwd: pageDir,
  env,
  stdio: "inherit",
  detached: true,
});
console.log(`[host-dev] vite group ${vite.pid}`);
await waitForPort(pagePort);

const electronPath = NodeModule.createRequire(NodePath.join(desktopDir, "package.json"))(
  "electron",
) as unknown as string;
let electron = launchElectron();
let stopping = false;

function launchElectron(): NodeChildProcess.ChildProcess {
  const child = NodeChildProcess.spawn(electronPath, [...electronArgs, "dist-electron/main.cjs"], {
    cwd: desktopDir,
    env: {
      ...env,
      VITE_DEV_SERVER_URL: `http://localhost:${pagePort}`,
      T3CODE_HOME: home,
      T3CODE_PORT: String(serverPort),
      ...(flags.devtools ? {} : { T3CODE_DESKTOP_DEVTOOLS: "0" }),
    },
    stdio: "inherit",
    detached: true,
  });
  console.log(`[host-dev] electron group ${child.pid}`);
  child.once("exit", (code) => {
    if (stopping) return;
    if (code === RELAUNCH_EXIT_CODE) {
      killGroup(child.pid);
      electron = launchElectron();
      return;
    }
    void stop(code ?? 0);
  });
  return child;
}

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (electron.exitCode === null && electron.signalCode === null) {
      // Electron's own quit stops the server it supervises; the group is the fallback.
      electron.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolve) => electron.once("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
      ]);
      if (!exited) killGroup(electron.pid);
    }
    killGroup(electron.pid);
    killGroup(vite.pid);
  }
  process.exit(code);
}
vite.once("exit", () => void stop(1));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => void stop(130));

/** Upstream's `localEnvironmentEnabled`, in the settings file its development run reads under `T3CODE_HOME`. */
function setLocalServer(value: string): void {
  if (value !== "on" && value !== "off") fail("--local-server takes on or off.");
  const file = NodePath.join(home, "userdata/desktop-settings.json");
  const settings: Record<string, unknown> = NodeFS.existsSync(file)
    ? JSON.parse(NodeFS.readFileSync(file, "utf8"))
    : {};
  settings.localEnvironmentEnabled = value === "on";
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`[host-dev] local server ${value} (${file})`);
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group has exited.
  }
}

function fail(message: string): never {
  console.error(`[host-dev] ${message}`);
  process.exit(1);
}

/** Whether anything answers on the port, over IPv4 or IPv6 loopback (Vite listens on `[::1]`). */
async function answers(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect(port, host);
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
  }
  return false;
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await answers(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  killGroup(vite.pid);
  fail(`Nothing answered on port ${port}.`);
}
