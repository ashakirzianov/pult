// @effect-diagnostics nodeBuiltinImport:off - the fixture drives the real CLI and server as a person would.
// @effect-diagnostics processEnvInEffect:off - the CLI reads its token from the server's environment, which a test swaps.
// Pult: a real `xaxis` against `scm-server serve` on a memory store, for the suites that drive an
// xaxis checkout (this driver's, and the Pult plugin's kept checkout). Skipped, with the reason
// printed, unless XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name the two binaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const XAXIS = process.env.XAXIS_TEST_BIN;
const SERVER = process.env.XAXIS_TEST_SERVER_BIN;
export const skipped = !XAXIS || !SERVER;
/** A suite's name, carrying the reason it is skipped, which the reporter prints. */
export const suiteName = (name: string) =>
  skipped
    ? `${name} (skipped: XAXIS_TEST_BIN and XAXIS_TEST_SERVER_BIN name no xaxis CLI and scm-server of JSON format 1)`
    : name;

/** A token of the right shape that no key holds. */
export const UNKNOWN_TOKEN = `xk:/root:${"0".repeat(64)}`;

export interface XaxisTestServer {
  readonly address: string;
  /** The root key's token, which `XAXIS_TOKEN` holds while the server runs. */
  readonly token: string;
  /** A real temp folder, removed by `stop`; `XAXIS_CONFIG_DIR` is its `config`. */
  readonly scratch: string;
  /** The CLI's stdout, run in `cwd`; a non-zero exit throws. */
  readonly xaxis: (cwd: string, ...args: string[]) => string;
  /** Kills the server by the PID captured at spawn, restores the environment, removes `scratch`. */
  readonly stop: () => void;
}

/** A changeset's hash, as `commit` prints it. */
export const committed = (output: string) => /as (sha256:[0-9a-f]{64})/.exec(output)![1]!;
/** A land rebases, so a changeset's landed hash is main's tip after it. */
export const landed = (output: string) => /main is at (sha256:[0-9a-f]{64})/.exec(output)![1]!;

export async function startXaxisTestServer(): Promise<XaxisTestServer> {
  const saved = { token: process.env.XAXIS_TOKEN, config: process.env.XAXIS_CONFIG_DIR };
  const scratch = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-xaxis-")),
  );
  const child = NodeChildProcess.spawn(SERVER!, ["serve", "--listen", "127.0.0.1:0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const { address, token } = await new Promise<{ address: string; token: string }>(
    (resolve, reject) => {
      const check = () => {
        const listening = /"address":"([^"]+)"/.exec(stdout)?.[1];
        const root = /root key: (\S+)/.exec(stderr)?.[1];
        if (listening && root) resolve({ address: listening, token: root });
      };
      child.stdout!.on("data", (chunk) => ((stdout += chunk), check()));
      child.stderr!.on("data", (chunk) => ((stderr += chunk), check()));
      child.on("exit", (code) => reject(new Error(`scm-server exited ${code}: ${stderr}`)));
    },
  );
  // The CLI runs on the server's environment as it is: these are what it reads.
  process.env.XAXIS_TOKEN = token;
  process.env.XAXIS_CONFIG_DIR = NodePath.join(scratch, "config");
  const xaxis = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync(XAXIS!, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const stop = () => {
    child.kill();
    process.env.XAXIS_TOKEN = saved.token;
    process.env.XAXIS_CONFIG_DIR = saved.config;
    if (saved.token === undefined) delete process.env.XAXIS_TOKEN;
    if (saved.config === undefined) delete process.env.XAXIS_CONFIG_DIR;
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  };
  return { address, token, scratch, xaxis, stop };
}
