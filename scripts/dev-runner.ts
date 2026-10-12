#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { resolveGitWorktreePath } from "@t3tools/shared/devHome";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type DevShareError, shareDevServer, unshareDevServer } from "./lib/dev-share.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { DEV_T3_HOME, T3CODE_CHECKOUT_VARIABLE, t3codeCheckoutPath } from "./pult/checkout.ts";

Object.assign(process.env, loadRepoEnv());

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
// HTTP(S) requests to these ports are blocked by the Fetch standard before a
// browser reaches the network. Keep the complete list here so explicit or
// future wider offsets cannot produce a URL that curl accepts but browsers
// reject. https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
// Dev servers bind loopback, so loopback is the only interface whose
// availability decides whether we can use a port. Probing wildcards too made
// the runner walk away from a perfectly free port whenever something else held
// the same number on another interface — `tailscale serve` does exactly that,
// which silently moved the ports out from under a URL that had just been shared.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

/**
 * Bind hosts on which a backend still answers `http://localhost:<port>`, which
 * is where single-origin browser dev proxies to. Loopback and the wildcards
 * qualify; a specific interface (e.g. a LAN IP) does not — the OS binds only
 * that address and the proxy target goes dark.
 */
export function isProxiableBindHost(host: string): boolean {
  const normalized = host.trim();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  );
}

/** The Vite+ task each mode runs for the client; dev:server runs none. */
const CLIENT_TASK_ARGS = {
  dev: ["run", "--filter=@pult/client", "dev"],
  "dev:server": undefined,
  "dev:web": ["run", "--filter=@pult/client", "dev"],
  "dev:desktop": ["run", "--filter=@pult/desktop", "--filter=@pult/client", "dev"],
} as const satisfies Record<string, ReadonlyArray<string> | undefined>;

type DevMode = keyof typeof CLIENT_TASK_ARGS;

/** The server's entry, relative to the fork checkout; it runs from source there. */
const SERVER_ENTRY = "apps/server/src/bin.ts";
/**
 * `role` matters because only the backend honours `--host`/`T3CODE_HOST`; the
 * web port is always loopback. Passed explicitly rather than inferred from the
 * port number, which stops distinguishing them under a large port offset.
 */
type PortAvailabilityCheck<R = never> = (
  port: number,
  role?: "server" | "web",
) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(CLIENT_TASK_ARGS) as Array<DevMode>;

/**
 * One process a mode starts: the client's Vite+ task, or the server, which this
 * repo does not carry. `dev` and `dev:server` run the server of the T3 Code
 * Extensible checkout from source, with Node's watch mode, in the checkout.
 */
export interface DevProcess {
  readonly role: "client" | "server";
  readonly executable: "vp" | "node";
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}

/** The processes `mode` starts. Extra run args go to the client, or to the server in dev:server. */
export function planDevProcesses(
  mode: DevMode,
  checkout: string,
  runArgs: ReadonlyArray<string> = [],
): ReadonlyArray<DevProcess> {
  const clientArgs = CLIENT_TASK_ARGS[mode];
  const processes: Array<DevProcess> = [];
  if (clientArgs !== undefined) {
    processes.push({ role: "client", executable: "vp", args: [...clientArgs, ...runArgs] });
  }
  if (mode === "dev" || mode === "dev:server") {
    processes.push({
      role: "server",
      executable: "node",
      args: ["--watch", SERVER_ENTRY, ...(mode === "dev:server" ? runArgs : [])],
      cwd: checkout,
    });
  }
  return processes;
}

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export class DevRunnerConfigurationError extends Schema.TaggedError<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedError<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("T3CODE_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedError<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedError<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literals(["vp", "node"]),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literals(["vp", "node"]),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export class DevRunnerCheckoutMissingError extends Schema.TaggedError<DevRunnerCheckoutMissingError>()(
  "DevRunnerCheckoutMissingError",
  {
    mode: Schema.Literals(["dev", "dev:server"]),
    checkout: Schema.String,
  },
) {
  override get message(): string {
    return `${this.mode} runs the server of a T3 Code Extensible checkout, and ${this.checkout} has no ${SERVER_ENTRY}. Set ${T3CODE_CHECKOUT_VARIABLE}, in the environment or .env, to a checkout with its dependencies installed.`;
  }
}

export class DevRunnerHostNotProxiableError extends Schema.TaggedError<DevRunnerHostNotProxiableError>()(
  "DevRunnerHostNotProxiableError",
  {
    mode: Schema.Literals(["dev", "dev:web"]),
    host: Schema.String,
  },
) {
  override get message(): string {
    return `--host ${this.host} cannot be combined with ${this.mode}: single-origin browser dev proxies the backend at localhost, and a backend bound only to ${this.host} leaves localhost unanswered, so every proxied request fails. Use a wildcard (0.0.0.0 or ::) to serve that interface and loopback together, or --share for remote access.`;
  }
}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.Boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.Port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.Int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "T3CODE_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }
    return Effect.succeed({
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return Effect.succeed({
        offset: Number(seed),
        source: `numeric T3CODE_DEV_INSTANCE=${seed}`,
      });
    }

    const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` });
  }

  // Worktrees get ports derived from their path so each one is stable across
  // restarts and distinct from its siblings. Without this every worktree starts
  // at offset 0 and scan-collides onto whatever happens to be free that minute,
  // so ports move under you between runs — which breaks any URL you already
  // shared. The main checkout keeps the documented 5733/13773.
  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    const offset = ((Hash.string(worktreePath) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `worktree ${worktreePath}` });
  }

  return Effect.succeed({ offset: 0, source: "default ports" });
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();
    return configured ? path.resolve(configured) : DEV_T3_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  t3Home,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    // --home-dir, else this checkout's .t3. An ambient T3CODE_HOME never
    // counts: an agent's shell inherits the live server's.
    const configuredBaseDir = t3Home?.trim() || undefined;
    const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
    };

    // Always exported: the fork's server would otherwise default to ~/.t3,
    // the live server's data.
    output.T3CODE_HOME = resolvedBaseDir;

    // A dev-runner server is never launcher-managed. When the shell that runs
    // this script was itself spawned by the machine's managed t3 service (an
    // agent working inside T3 Code), these leak through and the child server
    // fails startup with "The service launcher started a different t3 version"
    // (serviceLauncherClient.ts resolveStartup).
    delete output.T3_SERVICE_LAUNCHER_CONTEXT;
    delete output.T3_BOOT_SERVICE_UNIT;

    if (!isDesktopMode) {
      output.T3CODE_PORT = String(serverPort);
      // HOST is Vite's own bind address, and the desktop branch below is the
      // only place we set it. An inherited one (an exported HOST, a container,
      // a `HOST=0.0.0.0 npm start` habit) would otherwise reach Vite and pin
      // its HMR socket to that address — see the `explicitHost` gate in
      // apps/pult/vite.config.ts. Over a shared origin that is invisible: the
      // page loads and only HMR quietly dials the wrong machine.
      delete output.HOST;
      if (mode === "dev" || mode === "dev:web") {
        // Browser dev is single-origin: everything (including /ws) is proxied
        // through Vite, so the client must resolve its backend from
        // window.location.origin rather than a baked-in localhost URL. See
        // resolveConfiguredPrimaryTarget in apps/pult/src/environments/primary/target.ts
        // — it only defers to the origin when both of these are absent. Baking
        // localhost here is what breaks any non-localhost origin (tailnet, LAN,
        // phone): the remote browser dials its own machine.
        delete output.VITE_HTTP_URL;
        delete output.VITE_WS_URL;
        // Deleting is not enough on its own: vite.config.ts calls loadRepoEnv,
        // which merges `.env`/`.env.local` *under* this env, so a developer
        // with either URL in their `.env` would get it back and silently lose
        // single-origin mode. This states the intent positively so Vite can
        // ignore those values rather than infer from their absence.
        output.T3CODE_SINGLE_ORIGIN_DEV = "1";
      } else {
        output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
        output.VITE_WS_URL = `ws://localhost:${serverPort}`;
        delete output.T3CODE_SINGLE_ORIGIN_DEV;
      }
    } else {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      // Desktop pins the renderer to loopback on purpose; an ambient marker
      // must not make Vite drop those URLs.
      delete output.T3CODE_SINGLE_ORIGIN_DEV;
      delete output.T3CODE_MODE;
      delete output.T3CODE_NO_BROWSER;
      delete output.T3CODE_HOST;
      delete output.T3CODE_DEV_AUTH_TOKEN;
    }

    if (!isDesktopMode && host !== undefined) {
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode) {
      output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Hosts to probe for a dev server bound to `configuredHost`.
 *
 * Loopback is always checked because the web server and the desktop renderer
 * target reach it there. When `--host`/`T3CODE_HOST` moves the backend onto
 * another interface, that interface decides whether the bind actually
 * succeeds — probing only loopback would hand back a port that is free here
 * and taken there, and the server would fail to start.
 *
 * `configuredHost` applies to the *backend* only. Vite takes its bind address
 * from `HOST`, which the runner sets for desktop alone, so the web port stays
 * on loopback and must not be judged against the backend's interface —
 * a port free on loopback but busy on that interface would otherwise be
 * rejected for a server that was never going to bind there.
 */
export function devPortProbeHosts(configuredHost: string | undefined): ReadonlyArray<string> {
  const host = configuredHost?.trim();
  if (!host || DEV_PORT_PROBE_HOSTS.includes(host as (typeof DEV_PORT_PROBE_HOSTS)[number])) {
    return DEV_PORT_PROBE_HOSTS;
  }
  return [...DEV_PORT_PROBE_HOSTS, host];
}

const makeDefaultCheckPortAvailability =
  (configuredHost: string | undefined): PortAvailabilityCheck<NetService.NetService> =>
  (port, role) =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const hosts = role === "web" ? DEV_PORT_PROBE_HOSTS : devPortProbeHosts(configuredHost);
      return yield* checkPortAvailabilityOnHosts(port, hosts, (candidatePort, host) =>
        net.canListenOnHost(candidatePort, host),
      );
    });

const defaultCheckPortAvailability = makeDefaultCheckPortAvailability(undefined);

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerPortExhaustedError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      if (requireWebPort && !isBrowserAllowedPort(webPort)) {
        continue;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort, "server"));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort, "web"));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerPortExhaustedError({
      startOffset,
      requireServerPort,
      requireWebPort,
      baseServerPort: BASE_SERVER_PORT,
      baseWebPort: BASE_WEB_PORT,
      maximumPort: MAX_PORT,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  /** The T3 Code Extensible checkout whose server `dev` and `dev:server` run. */
  readonly checkout: string;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerConfigurationError({
            configKeys: ["T3CODE_PORT_OFFSET", "T3CODE_DEV_INSTANCE"],
            cause,
          }),
      ),
    );

    // Single-origin browser dev proxies the backend at localhost. A wildcard
    // bind still answers there; a specific non-loopback interface does not,
    // which breaks every proxied request in a way that reads as "server is
    // broken" rather than "flag combination is unsupported". Reject it up
    // front instead. (dev:server and dev:desktop don't proxy — untouched.)
    if (
      (input.mode === "dev" || input.mode === "dev:web") &&
      input.host !== undefined &&
      !isProxiableBindHost(input.host)
    ) {
      return yield* new DevRunnerHostNotProxiableError({ mode: input.mode, host: input.host });
    }

    const worktreePath = yield* resolveGitWorktreePath(yield* HostProcessWorkingDirectory);

    const { offset, source } = yield* resolveOffset({
      portOffset,
      devInstance,
      worktreePath,
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
      // A non-loopback bind host decides whether the backend can actually take
      // the port, so it has to be probed alongside loopback.
      checkPortAvailability: makeDefaultCheckPortAvailability(input.host),
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: yield* HostProcessEnvironment,
      serverOffset,
      webOffset,
      t3Home: input.t3Home,
      browser: input.browser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";
    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.T3CODE_HOME)}`,
    );

    const processes = planDevProcesses(input.mode, input.checkout, input.runArgs);
    for (const devProcess of processes) {
      yield* Effect.logInfo(
        `[dev-runner] ${devProcess.role}: ${[devProcess.executable, ...devProcess.args].join(" ")}${devProcess.cwd ? ` (in ${devProcess.cwd})` : ""}`,
      );
    }

    // Before the share block: --dry-run only resolves and prints. Sharing would
    // replace, then tear down, whatever mapping the port already had — a
    // surprising side effect from a command documented as inert.
    if (input.dryRun) {
      return;
    }

    const sharedWebPort = BASE_WEB_PORT + webOffset;
    if (input.share) {
      if (input.mode === "dev:server") {
        yield* Effect.logInfo("[dev-runner] --share has no effect for dev:server (no web server).");
      } else if (input.mode === "dev:desktop") {
        // Desktop is not single-origin: the renderer gets VITE_HTTP_URL and
        // VITE_WS_URL baked to loopback, so a tailnet visitor would load the UI
        // and then watch it dial its own 127.0.0.1 for the backend. Worse,
        // sharing would overwrite VITE_DEV_SERVER_URL, which is the origin
        // Electron itself loads the renderer from. Refuse rather than hand out
        // a URL that is broken in a way the user cannot see.
        yield* Effect.logWarning(
          "[dev-runner] --share is not supported for dev:desktop (the renderer is pinned to loopback). Use `dev`, which runs the whole browser stack.",
        );
      } else {
        // acquireRelease, not share-then-addFinalizer: the mapping outlives this
        // process (and reboots), so the cleanup has to be registered atomically
        // with creating it. An interrupt landing in between would otherwise
        // leave a mapping pointing at a port nothing is listening on.
        //
        // Deliberately no ownership tracking beyond that: if a second runner
        // takes this port during a fast restart, the first's exit can briefly
        // tear down the new mapping — visible (the URL stops working) and fixed
        // by re-running --share. A lease protocol closing that window existed
        // and was removed as more machinery than a dev convenience warrants.
        //
        // A tailnet that isn't up shouldn't stop the dev server from starting —
        // warn, and carry on serving locally.
        const shared = yield* Effect.acquireRelease(
          shareDevServer({ webPort: sharedWebPort }),
          () =>
            // Serve config outlives this process, so a cleanup that did not
            // take leaves a tailnet URL pointing at a port nothing serves.
            unshareDevServer(sharedWebPort).pipe(
              Effect.flatMap((result) =>
                result.cleared
                  ? Effect.void
                  : Effect.logWarning(
                      `[dev-runner] could not remove the tailnet mapping for port ${String(sharedWebPort)}${
                        result.explanation ? `: ${result.explanation}` : ""
                      }. Remove it with \`tailscale serve --https=${String(sharedWebPort)} off\`.`,
                    ),
              ),
            ),
        ).pipe(
          Effect.tapError((error: DevShareError) =>
            Effect.logWarning(
              `[dev-runner] could not share on the tailnet: ${error.message}${
                error.hint ? ` — ${error.hint}` : ""
              }`,
            ),
          ),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        );

        if (shared) {
          // The app is reached from the tailnet origin. Vite already allows
          // *.ts.net hosts; the backend needs the origin for credentialed
          // requests that bypass the proxy (desktop renderer, direct calls).
          env.T3CODE_DEV_ALLOWED_ORIGINS = [
            env.T3CODE_DEV_ALLOWED_ORIGINS,
            new URL(shared.url).origin,
          ]
            .filter((entry) => entry && entry.length > 0)
            .join(",");
          // The server builds its pairing URL from this, so the URL printed at
          // startup is already the shareable one — no rewriting by hand. An
          // explicit --dev-url still wins.
          if (input.devUrl === undefined) {
            env.VITE_DEV_SERVER_URL = shared.url;
          }
          // A shared origin serves a remote browser, where unbundled dev's
          // per-module requests each pay a tailnet round trip — a cold module
          // graph takes minutes to first paint. Bundled dev collapses that to
          // a few chunk requests. Only defaulted, so T3CODE_BUNDLED_DEV=0
          // still opts a --share run back out.
          if (env.T3CODE_BUNDLED_DEV === undefined) {
            env.T3CODE_BUNDLED_DEV = "1";
          }
          yield* Effect.logInfo(`[dev-runner] shared on tailnet: ${shared.url}`);
        }
      }
    }

    if (processes.some((devProcess) => devProcess.role === "server")) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (
        !(yield* fs
          .exists(path.join(input.checkout, SERVER_ENTRY))
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new DevRunnerCheckoutMissingError({
          mode: input.mode === "dev" ? "dev" : "dev:server",
          checkout: input.checkout,
        });
      }
    }

    // A process that fails or exits non-zero ends the run; the scope then
    // stops the others.
    yield* Effect.forEach(processes, (devProcess) => runDevProcess(input.mode, devProcess, env), {
      concurrency: "unbounded",
      discard: true,
    });
  });
}

// How long each step of stopping a child's process tree may take before the
// next, harder one.
const STOP_GRACE_MILLIS = 5_000;
const STOP_POLL_MILLIS = 50;

/** `root` and every process under it, from the output of `ps -A -o pid=,ppid=`. */
export function processTree(psOutput: string, root: number): ReadonlyArray<number> {
  const children = new Map<number, Array<number>>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !(pid > 0) || !(ppid > 0)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = new Set([root]);
  for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child);
  return [...tree];
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalAll = (pids: ReadonlyArray<number>, signal: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

const awaitExit = (pids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < STOP_GRACE_MILLIS; waited += STOP_POLL_MILLIS) {
      if (!pids.some(isAlive)) return;
      yield* Effect.sleep(STOP_POLL_MILLIS);
    }
  });

/**
 * Stops a running child and whatever it started. Effect's own kill reaches the
 * child alone, as the children share the runner's process group so that a
 * terminal's Ctrl+C reaches them directly; and `vp run` exits on SIGTERM without
 * passing it on, so a SIGTERM or SIGINT sent to the runner left Vite running,
 * holding its port. The child goes first: the server's `node --watch` passes the
 * signal on and waits, and a second one would cut the server's shutdown short.
 */
const stopProcessTree = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    // Windows' kill already takes the tree (taskkill /T), and an exited
    // child's pid may name another process by now.
    if ((yield* HostProcessPlatform) === "win32" || !(yield* child.isRunning)) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const psOutput = yield* spawner.string(ChildProcess.make("ps", ["-A", "-o", "pid=,ppid="]));
    const descendants = processTree(psOutput, child.pid).filter((pid) => pid !== child.pid);
    yield* child.kill({ forceKillAfter: STOP_GRACE_MILLIS });
    const left = descendants.filter(isAlive);
    signalAll(left, "SIGTERM");
    yield* awaitExit(left);
    signalAll(left.filter(isAlive), "SIGKILL");
  }).pipe(Effect.ignore);

const runDevProcess = (mode: DevMode, devProcess: DevProcess, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawnCommand =
      devProcess.executable === "vp"
        ? yield* resolveSpawnCommand("vp", devProcess.args, { env })
        : { command: yield* HostProcessExecutablePath, args: devProcess.args, shell: false };
    const processContext = {
      mode,
      executable: devProcess.executable,
      argumentCount: spawnCommand.args.length,
      shell: spawnCommand.shell,
    } as const;
    const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(devProcess.cwd ? { cwd: devProcess.cwd } : {}),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      shell: spawnCommand.shell,
      // Keep each child in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put the runner in a new group and require manual forwarding.
      detached: false,
      forceKillAfter: "1500 millis",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "spawn",
            cause,
          }),
      ),
    );
    // Added after the spawn, so it runs before the spawn's own release.
    yield* Effect.addFinalizer(() => stopProcessTree(child));

    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "wait-for-exit",
            cause,
          }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new DevRunnerProcessExitError({
        ...processContext,
        exitCode,
      });
    }
  });

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.Literals("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  t3Home: Flag.String("home-dir").pipe(
    Flag.withDescription(
      "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME). Defaults to this checkout's own .t3, a worktree's or the main checkout's, whatever T3CODE_HOME says.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  browser: Flag.Boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
    Flag.withDefault(false),
  ),
  autoBootstrapProjectFromCwd: Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.Boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.String("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Resolve mode/ports/env and the commands, and print them, but spawn nothing.",
    ),
    Flag.withDefault(false),
  ),
  share: Flag.Boolean("share").pipe(
    Flag.withDescription(
      "Publish the web dev server on this machine's tailnet over HTTPS (via `tailscale serve`) and print the pairing URL for it. Removed again on exit.",
    ),
    Flag.withDefault(false),
  ),
  runArgs: Argument.String("run-arg").pipe(
    Argument.withDescription(
      "Additional args (pass after `--`): Vite+ run args for the client, or the server's args in dev:server.",
    ),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run Pult's development modes with deterministic port/env wiring."),
  Command.withHandler((input) =>
    runDevRunnerWithInput({ ...input, checkout: t3codeCheckoutPath() }),
  ),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
