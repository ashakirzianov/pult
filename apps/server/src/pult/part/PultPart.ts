/**
 * Pult's server part: one separately deployed process the server runs beside
 * itself, which contributes MCP tools (`PultPartTools.ts`) and HTTP routes
 * (`PultPartProxy.ts`).
 *
 * The part is `main.mjs` in the configured part directory, run with the
 * server's own Node runtime. On fd 3 it receives one JSON line, the
 * handshake: the server's loopback URL and a bearer for its ordinary client
 * API (never in the environment, which leaks into provider processes), the
 * secret the server presents on every request it forwards, and a data
 * directory of its own. It answers on fd 4 with one JSON line, `{"port": N}`,
 * once it serves plain MCP at `/mcp` and its routes on that loopback port.
 *
 * The server supervises it with backoff, restarts it when the part directory
 * moves to another build (a deploy or a roll back repoints `current`), and
 * runs the fallback directory's part (the previous build's) when a new one
 * does not come up in time.
 */
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { PART_ENTRY_FILE } from "@t3tools/shared/pult/payloadSlot";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerActivation from "../../serverActivation.ts";

/** Where the server reverse-proxies the part's HTTP routes. */
export const PART_ROUTE_PREFIX = "/api/pult/part";

export type PultPartState =
  /** No part directory holds a `main.mjs`. */
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Starting"; readonly dir: string }
  | {
      readonly _tag: "Ready";
      /** The build directory the part runs from, links resolved. */
      readonly dir: string;
      readonly origin: string;
      readonly secret: string;
    }
  | { readonly _tag: "Down"; readonly reason: string };

export class PultPart extends Context.Service<
  PultPart,
  {
    readonly state: SubscriptionRef.SubscriptionRef<PultPartState>;
  }
>()("t3/pult/part/PultPart") {}

/**
 * Settles once the server knows what the part contributes to a new provider
 * session: its tools are registered, there is no part, or its first start
 * failed. Sessions wait on it, bounded, because a session's tool list is
 * fixed when it starts.
 */
export class PultPartGate extends Context.Service<
  PultPartGate,
  {
    readonly settle: Effect.Effect<void>;
    readonly await: Effect.Effect<void>;
  }
>()("t3/pult/part/PultPart/PultPartGate") {}

export const gateLayer = Layer.effect(
  PultPartGate,
  Effect.gen(function* () {
    const settled = yield* Deferred.make<void>();
    return PultPartGate.of({
      settle: Deferred.succeed(settled, undefined).pipe(Effect.asVoid),
      await: Deferred.await(settled),
    });
  }),
);

export interface PultPartOptions {
  /** How long a started part has to report its port. */
  readonly readyTimeout?: Duration.Input;
  /** How often the part directory is checked for a deploy. */
  readonly pollInterval?: Duration.Input;
}

const DEFAULT_READY_TIMEOUT = Duration.seconds(15);
const DEFAULT_POLL_INTERVAL = Duration.seconds(2);
// The same crash-loop policy as the relay connector's: a part that stays up
// this long earns an immediate restart again.
const STABLE_UPTIME_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** What the part reads from fd 3. */
const PartHandshake = Schema.Struct({
  /** The server's loopback origin, for its ordinary client API. */
  serverUrl: Schema.String,
  /** A bearer for that API, with a paired client's scopes; revoked when this run ends. */
  token: Schema.String,
  /** Sent as `authorization: Bearer <secret>` on every request the server forwards. */
  secret: Schema.String,
  /** The part's own state directory. */
  dataDir: Schema.String,
  /** The path under which the server proxies the part's routes, stripped before forwarding. */
  routePrefix: Schema.String,
});
const encodeHandshake = Schema.encodeSync(Schema.fromJsonString(PartHandshake));

const ReadyLine = Schema.fromJsonString(Schema.Struct({ port: Schema.Int }));
const decodeReadyLine = Schema.decodeUnknownOption(ReadyLine);

class PartNotReady extends Schema.TaggedError<PartNotReady>()("PartNotReady", {
  reason: Schema.String,
}) {}

type RunOutcome =
  | { readonly _tag: "Moved" }
  | { readonly _tag: "Exited"; readonly uptimeMs: number }
  | { readonly _tag: "NotReady"; readonly reason: string };

const bytesToBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const make = Effect.fn("PultPart.make")(function* (options: PultPartOptions = {}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpServer = yield* HttpServer.HttpServer;
  const gate = yield* PultPartGate;
  const state = yield* SubscriptionRef.make<PultPartState>({ _tag: "Absent" });
  const readyTimeout = Duration.fromInputUnsafe(options.readyTimeout ?? DEFAULT_READY_TIMEOUT);
  const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? DEFAULT_POLL_INTERVAL);
  const dataDir = path.join(config.stateDir, "part");

  // A wildcard bind is reachable on loopback, where the part runs.
  const serverOrigin = NetAddress.isInetAddress(httpServer.address)
    ? `http://${
        NetAddress.isUnspecified(httpServer.address.address)
          ? "127.0.0.1"
          : NetAddress.formatUrlHostString(NetAddress.formatIp(httpServer.address.address))
      }:${httpServer.address.port}`
    : "http://127.0.0.1";

  /** The build directory a part directory resolves to, when it holds a part. */
  const resolvePart = (dir: string | undefined) =>
    dir === undefined
      ? Effect.succeed(Option.none<string>())
      : fs.realPath(dir).pipe(
          Effect.flatMap((real) =>
            fs
              .exists(path.join(real, PART_ENTRY_FILE))
              .pipe(Effect.map((exists) => (exists ? Option.some(real) : Option.none<string>()))),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        );

  /** Completes when the part directory resolves to something other than `known`. */
  const awaitMove = (known: Option.Option<string>) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pollInterval);
        const current = yield* resolvePart(config.partDir);
        if (Option.getOrUndefined(current) !== Option.getOrUndefined(known)) return;
      }
    });

  const logOutput = (child: ChildProcessSpawner.ChildProcessHandle) =>
    child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((output) =>
        Effect.logInfo("server part output", { pid: Number(child.pid), output }),
      ),
      Effect.ignore,
    );

  const awaitReadyPort = (child: ChildProcessSpawner.ChildProcessHandle) =>
    child.getOutputFd(4).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new PartNotReady({ reason: "it exited before reporting its port" })),
          onSome: (line) =>
            Option.match(decodeReadyLine(line), {
              onNone: () => Effect.fail(new PartNotReady({ reason: `it reported "${line}"` })),
              onSome: ({ port }) => Effect.succeed(port),
            }),
        }),
      ),
      Effect.mapError((error) =>
        error._tag === "PartNotReady" ? error : new PartNotReady({ reason: String(error) }),
      ),
      Effect.timeoutOrElse({
        duration: readyTimeout,
        orElse: () =>
          Effect.fail(
            new PartNotReady({
              reason: `it did not report its port within ${Duration.format(readyTimeout)}`,
            }),
          ),
      }),
    );

  /**
   * Runs the part in `runDir` (resolved to `buildDir`) until it exits, or
   * until the configured part directory stops resolving to `watched`.
   */
  const runOnce = (runDir: string, buildDir: string, watched: Option.Option<string>) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      return yield* Effect.gen(function* () {
        yield* SubscriptionRef.set(state, { _tag: "Starting", dir: buildDir });
        const session = yield* environmentAuth.issueSession({
          subject: "pult-server-part",
          label: "Pult server part",
          scopes: AuthStandardClientScopes,
        });
        yield* Scope.addFinalizer(
          scope,
          environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
        );
        const secret = yield* crypto.randomBytes(32).pipe(Effect.map(bytesToBase64Url));
        yield* fs.makeDirectory(dataDir, { recursive: true });
        const child = yield* spawner
          .spawn(
            ChildProcess.make(process.execPath, [path.join(buildDir, PART_ENTRY_FILE)], {
              cwd: buildDir,
              // The server may itself run as Electron; this makes its binary a plain Node.
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              shell: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } },
              forceKillAfter: "3 seconds",
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.logInfo("server part started", { pid: Number(child.pid), dir: buildDir });
        yield* Effect.forkIn(logOutput(child), scope);
        const handshake = `${encodeHandshake({
          serverUrl: serverOrigin,
          token: session.token,
          secret,
          dataDir,
          routePrefix: PART_ROUTE_PREFIX,
        })}\n`;
        yield* Stream.make(new TextEncoder().encode(handshake)).pipe(
          Stream.run(child.getInputFd(3)),
          Effect.ignore({ log: true }),
        );
        const port = yield* awaitReadyPort(child);
        yield* SubscriptionRef.set(state, {
          _tag: "Ready",
          dir: buildDir,
          origin: `http://127.0.0.1:${port}`,
          secret,
        });
        yield* Effect.logInfo("server part ready", { pid: Number(child.pid), port });
        return yield* Effect.raceFirst(
          child.exitCode.pipe(
            Effect.ignore,
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((now): RunOutcome => ({ _tag: "Exited", uptimeMs: now - startedAt })),
          ),
          awaitMove(watched).pipe(Effect.as<RunOutcome>({ _tag: "Moved" })),
        );
      }).pipe(
        Effect.catchTag("PartNotReady", (error) =>
          Effect.succeed<RunOutcome>({ _tag: "NotReady", reason: error.reason }),
        ),
        Effect.catch((error) =>
          Effect.succeed<RunOutcome>({ _tag: "NotReady", reason: String(error) }),
        ),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    });

  const supervise = Effect.gen(function* () {
    let backoffMs = 0;
    const waitOrMove = (known: Option.Option<string>) =>
      backoffMs === 0
        ? Effect.void
        : Effect.raceFirst(Effect.sleep(Duration.millis(backoffMs)), awaitMove(known));
    const nextBackoff = () => {
      backoffMs = backoffMs === 0 ? BACKOFF_BASE_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    };
    while (true) {
      const live = yield* resolvePart(config.partDir);
      if (Option.isNone(live)) {
        yield* SubscriptionRef.set(state, { _tag: "Absent" });
        yield* gate.settle;
        yield* awaitMove(live);
        backoffMs = 0;
        continue;
      }
      const outcome = yield* runOnce(config.partDir!, live.value, live);
      if (outcome._tag === "Moved") {
        backoffMs = 0;
        continue;
      }
      if (outcome._tag === "Exited") {
        yield* SubscriptionRef.set(state, { _tag: "Down", reason: "the part exited" });
        if (outcome.uptimeMs >= STABLE_UPTIME_MS) backoffMs = 0;
        yield* Effect.logWarning("server part exited; restarting", {
          uptimeMs: outcome.uptimeMs,
          backoffMs,
        });
        yield* waitOrMove(live);
        if (outcome.uptimeMs < STABLE_UPTIME_MS) nextBackoff();
        continue;
      }
      yield* Effect.logWarning("server part did not come up", {
        dir: live.value,
        reason: outcome.reason,
      });
      const fallback = yield* resolvePart(config.partFallbackDir);
      if (Option.isSome(fallback) && fallback.value !== live.value) {
        yield* Effect.logWarning("running the previous build's server part", {
          dir: fallback.value,
        });
        const fallbackOutcome = yield* runOnce(config.partFallbackDir!, fallback.value, live);
        if (fallbackOutcome._tag === "Moved") {
          backoffMs = 0;
          continue;
        }
      }
      yield* SubscriptionRef.set(state, {
        _tag: "Down",
        reason: `the part did not come up: ${outcome.reason}`,
      });
      yield* gate.settle;
      nextBackoff();
      yield* waitOrMove(live);
    }
  });

  yield* ServerActivation.forkParked(supervise);
  return PultPart.of({ state });
});

export const layer = (options?: PultPartOptions) => Layer.effect(PultPart, make(options));
