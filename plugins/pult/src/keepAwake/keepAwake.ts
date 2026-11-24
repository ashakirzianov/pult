// Keeps this Mac awake while agents work (xaxis `pult/tasks/keep-awake-while-agents-work.task`): while the server
// is not at rest by `ServerActivity`, a `caffeinate -s -i -w <server pid>` child holds a sleep assertion, which
// goes with the server's process however it ends. The switch is `<stateDir>/plugins/pult/keep-awake-off`, written
// only by the route below.
import {
  ChildProcess,
  ChildProcessSpawner,
  Effect,
  Exit,
  FileSystem,
  HostProcess,
  HttpServerRequest,
  HttpServerResponse,
  Path,
  Scheduler,
  Schema,
  Scope,
  ServerActivity,
  ServerConfig,
} from "../host.ts";

/** The feature `about` names where the server holds the assertion: darwin alone. */
export const FEATURE = "keep-awake";

/** What the plugin does not do yet, loud where it is asked for: `grep 'todo('` lists it. */
function todo(reason: string): never {
  throw new Error(`todo: ${reason}`);
}

/** The command that holds the machine awake for as long as `pid` lives. */
const holdCommand = (platform: NodeJS.Platform, pid: number): ChildProcess.Command => {
  switch (platform) {
    case "darwin":
      // -s is PreventSystemSleep, which macOS honours on AC alone; -i, PreventUserIdleSystemSleep, is what holds on
      // battery. On AC, -i alone taken inside a maintenance dark wake does not hold (xaxis
      // `pult/tasks/keep-awake-does-not-hold-a-sleeping-mac.task`). -w ends both with the server's process.
      return ChildProcess.make("/usr/bin/caffeinate", ["-s", "-i", "-w", String(pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    case "linux":
      return todo("pult/tasks/linux-support.task: keep-awake");
    case "win32":
      return todo("pult/tasks/windows-support.task: keep-awake");
    default:
      return todo(`keep-awake on ${platform}`);
  }
};

export interface KeepAwake {
  /** Whether this server holds the assertion at all: `about` names `keep-awake` only then. */
  readonly available: boolean;
  /** `GET`/`POST /keep-awake`, `{ on }`; undefined for any other path, and for every path where it is not available. */
  readonly route: (
    request: HttpServerRequest.HttpServerRequest,
    path: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse> | undefined;
}

const decodeBody = Schema.decodeUnknownEffect(Schema.Struct({ on: Schema.Boolean }));

export const make = Effect.fn("KeepAwake.make")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin")
    return { available: false, route: () => undefined } satisfies KeepAwake;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const activity = yield* ServerActivity.ServerActivity;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scheduler = yield* Scheduler.Scheduler;
  const scope = yield* Effect.scope;

  const offFile = path.join(config.stateDir, "plugins", "pult", "keep-awake-off");
  let on = !(yield* fs
    .exists(offFile)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("Could not look for keep-awake-off.", { offFile, cause }),
          false,
        ),
      ),
    ));
  const command = holdCommand(platform, process.pid);

  /** The child this plugin spawned, in a scope of its own whose close ends it. */
  let child:
    | { readonly handle: ChildProcessSpawner.ChildProcessHandle; readonly scope: Scope.Closeable }
    | undefined;
  // Each told once per busy spell.
  let toldExit = false;
  let toldSpawn = false;

  const release = Effect.suspend(() => {
    const held = child;
    child = undefined;
    return held === undefined ? Effect.void : Scope.close(held.scope, Exit.void);
  });

  const pass = Effect.gen(function* () {
    const wanted = on && !(yield* activity.current).atRest;
    if (child !== undefined && !(yield* child.handle.isRunning)) {
      yield* release;
      if (wanted && !toldExit) {
        toldExit = true;
        yield* Effect.logWarning("keep-awake: caffeinate exited on its own; holding again.");
      }
    }
    if (!wanted) {
      toldExit = false;
      toldSpawn = false;
      return yield* release;
    }
    if (child !== undefined) return;
    const childScope = yield* Scope.fork(scope);
    const spawned = yield* spawner.spawn(command).pipe(Scope.provide(childScope), Effect.result);
    if (spawned._tag === "Success") {
      child = { handle: spawned.success, scope: childScope };
      return;
    }
    yield* Scope.close(childScope, Exit.void);
    if (!toldSpawn) {
      toldSpawn = true;
      yield* Effect.logWarning("keep-awake: could not spawn caffeinate; trying each tick.", {
        cause: spawned.failure,
      });
    }
  });
  yield* scheduler.register("pult-keep-awake", pass);

  const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
  const write = (next: boolean) =>
    (next
      ? fs.remove(offFile, { force: true })
      : fs
          .makeDirectory(path.dirname(offFile), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(offFile, "")))
    ).pipe(Effect.tap(() => Effect.sync(() => (on = next))));

  const route: KeepAwake["route"] = (request, routePath) => {
    if (routePath !== "/keep-awake") return undefined;
    if (request.method === "GET") return Effect.sync(() => json({ on }));
    // POST, not PUT: a page on another origin may send a browser API only the methods the server's CORS allows.
    if (request.method === "POST")
      return Effect.gen(function* () {
        const body = yield* request.json.pipe(Effect.flatMap(decodeBody), Effect.option);
        if (body._tag === "None") return json({ error: "The body must be JSON: { on }." }, 400);
        yield* write(body.value.on);
        return json({ on });
      }).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));
    return undefined;
  };
  return { available: true, route } satisfies KeepAwake;
});
