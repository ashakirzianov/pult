/**
 * The release workflow's smoke test (`.github/workflows/pult-release.yml`),
 * modelled on upstream's `scripts/smoke-desktop-app.ts`: mounts Pult.app's
 * dmg, launches the app against a temporary `T3CODE_HOME` seeded with
 * upstream's fixture database, and passes once the page is connected to the
 * app's own server (`html[data-pult-local="connected"]`) and the fixture's
 * thread is in the panel. A build whose server or page cannot start fails here,
 * before it is published.
 *
 *   node apps/pult/desktop/scripts/smoke.ts --dmg <Pult-x.y.z-arm64.dmg> [--artifacts-dir <dir>]
 *
 * On failure the artifacts directory holds a screenshot of the window and the
 * server's logs. Run it on CI, not on a machine with an installed Pult: the
 * packaged app's `userData` is the installed one's.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import { _electron, type ElectronApplication, type Page } from "playwright-core";

const root = NodePath.resolve(import.meta.dirname, "../../../..");
// An older schema on purpose: the packaged server migrates it forward, as for every upgrading user.
const FIXTURE_DB = NodePath.join(root, "scripts/fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const STEP_TIMEOUT_MS = 90_000;

const { values } = NodeUtil.parseArgs({
  options: { dmg: { type: "string" }, "artifacts-dir": { type: "string" } },
});
if (!values.dmg) throw new Error("Usage: smoke.ts --dmg <dmg> [--artifacts-dir <dir>]");
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "pult-smoke");

const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pult-smoke-"));
const mount = NodePath.join(temp, "dmg");
const t3Home = NodePath.join(temp, "t3");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));

let step = "mounting the dmg";
let app: ElectronApplication | undefined;
let page: Page | undefined;
let mounted = false;
try {
  NodeChildProcess.execFileSync("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
    NodePath.resolve(values.dmg),
  ]);
  mounted = true;
  const bundle = NodeFS.readdirSync(mount).find((name) => name.endsWith(".app"));
  if (bundle === undefined) throw new Error(`No .app in ${values.dmg}.`);
  const plist = NodePath.join(mount, bundle, "Contents/Info.plist");
  const executable = NodeChildProcess.execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", plist],
    { encoding: "utf8" },
  ).trim();

  step = "launching the app";
  app = await _electron.launch({
    executablePath: NodePath.join(mount, bundle, "Contents/MacOS", executable),
    // HOME stays real: a fake HOME has no login keychain, and safeStorage blocks on a keychain dialog.
    env: {
      ...process.env,
      T3CODE_HOME: t3Home,
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
    },
    timeout: STEP_TIMEOUT_MS,
  });
  step = "waiting for the first window";
  page = await app.firstWindow({ timeout: STEP_TIMEOUT_MS });
  step = "waiting for the page to connect to the app's own server";
  await page.locator('html[data-pult-local="connected"]').waitFor({
    state: "attached",
    timeout: STEP_TIMEOUT_MS,
  });
  step = `finding "${THREAD_TITLE}" in the panel`;
  await page
    .locator(".pult-card-title", { hasText: THREAD_TITLE })
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS });
  console.log("Pult smoke test passed: the server started, the page connected, the thread shows.");
} catch (error) {
  console.error(`Pult smoke test failed while ${step}.`);
  console.error(error instanceof Error ? error.message : error);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  if (page !== undefined) {
    const local = await page
      .evaluate(() => document.documentElement.dataset.pultLocal ?? "(absent)")
      .catch(() => "(unreadable)");
    console.error(`data-pult-local: ${local}`);
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
      .catch(() => {});
  }
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast server output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-30).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  if (app !== undefined) {
    // A hung app never finishes closing; Playwright drops the process handle once it closes, so read it first.
    const child = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, NodeTimersPromises.setTimeout(10_000, undefined, { ref: false })]);
    child.kill("SIGKILL");
  }
  if (mounted) {
    try {
      NodeChildProcess.execFileSync("hdiutil", ["detach", mount, "-force"]);
    } catch {
      // The runner discards the mount with the job.
    }
  }
  NodeFS.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}
