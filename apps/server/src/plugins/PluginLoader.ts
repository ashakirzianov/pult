/**
 * Loads in-process plugins at startup: the bundled ones compiled into the server, then each
 * installed extension, `<home>/plugins/<name>/` with an `extension.json` beside its `main.mjs`,
 * refused before import when this server does not serve its contract or its Effect. A running
 * one changes only with a restart. See docs/internals/plugins.md.
 */
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Scope from "effect/Scope";
import type { McpServer } from "effect/ai";
import type { HttpServerRequest, HttpServerResponse } from "effect/http";
import effectPackage from "effect/package.json" with { type: "json" };

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CONTRACT, type ExtensionHost, Manifest } from "./contract.ts";
import * as ExtensionContract from "./ExtensionContract.ts";
import * as ExtensionUi from "./ExtensionUi.ts";

/** The bare specifier an extension's build leaves external; resolved to the extension entry here. */
const HOST_SPECIFIER = "@pult/extension-host";

/** Plugin names are single path segments. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));

export class PluginRefusedError extends Schema.TaggedError<PluginRefusedError>()(
  "PluginRefusedError",
  {
    plugin: Schema.String,
    reason: Schema.String,
    /** The extension's own version, when its manifest decoded. */
    version: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Extension "${this.plugin}" is refused: ${this.reason}.`;
  }
}

export class PluginImportError extends Schema.TaggedError<PluginImportError>()(
  "PluginImportError",
  { plugin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin "${this.plugin}" failed to import.`;
  }
}

export class PluginActivateError extends Schema.TaggedError<PluginActivateError>()(
  "PluginActivateError",
  { plugin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Plugin "${this.plugin}" failed to activate.`;
  }
}

type PluginLoadError = PluginRefusedError | PluginImportError | PluginActivateError;

const describeLoadError = (error: PluginLoadError): string =>
  "cause" in error ? `${error.message} ${describeCause(error.cause)}` : error.message;

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

/** A row of `GET /api/plugins`, the list the Extensions tab reads. */
export interface PluginStatus {
  readonly name: string;
  /** An extension's own, from its manifest; a bundled plugin's is the server's. */
  readonly version: string | undefined;
  readonly kind: "bundled" | "installed";
  /** `refused`: turned away before any of its code ran; `failed`: its import or activation failed. */
  readonly status: "loaded" | "failed" | "refused";
  readonly error: string | undefined;
  readonly loadedAt: string | undefined;
}

/**
 * Answers `/api/plugins/<name>/<path>`; a failure or defect becomes a 500. The
 * session already holds `orchestration:read` for GET and HEAD and `access:write`
 * otherwise; `scopes` are all of it, for the handler to gate further.
 */
export type PluginRouteHandler = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

/**
 * What a bundled plugin's `activate` receives: the raw tier (`context`, `serve`), and the contract
 * an installed extension of its name would get. The activation already runs with `context` provided.
 */
export interface PluginHost {
  readonly name: string;
  readonly context: Context.Context<McpServer.McpServer>;
  /** Serve `/api/plugins/<name>/<path>` once activation succeeds; the last call wins. */
  readonly serve: (handler: PluginRouteHandler) => Effect.Effect<void>;
  readonly extension: ExtensionHost;
}

/**
 * Plugins compiled into the server, by name, each importing its module, which exports `activate`
 * returning an Effect. A bundled name shadows `<home>/plugins/<name>`.
 */
export type BundledPlugins = Readonly<
  Record<string, () => Promise<{ readonly activate: (host: PluginHost) => unknown }>>
>;

interface Running {
  readonly scope: Scope.Closeable;
  readonly loadedAt: string;
  readonly route: PluginRouteHandler | undefined;
}

interface PluginRecord {
  readonly status: PluginStatus;
  readonly running: Running | undefined;
}

export class PluginLoader extends Context.Service<
  PluginLoader,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginStatus>>;
    /** The route handler of a running bundled plugin, if it registered one. */
    readonly route: (name: string) => PluginRouteHandler | undefined;
  }
>()("t3/plugins/PluginLoader") {}

type Version = readonly [number, number, number];

const parseVersion = (text: string): Version | undefined => {
  const match = VERSION_PATTERN.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isNewer = (left: Version, right: Version): boolean => {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
};

/** Why an extension built against Effect `wanted` cannot run on `served`: the caret range. */
const effectRefusal = (wanted: string, served: Version): string | undefined => {
  const version = parseVersion(wanted);
  const server = served.join(".");
  if (version === undefined) return `its manifest's effect "${wanted}" is not a version x.y.z`;
  if (version[0] !== served[0])
    return `it was built against Effect ${wanted}, and this server runs Effect ${server}, another major`;
  if (isNewer(version, served))
    return `it was built against Effect ${wanted}, newer than this server's ${server}`;
  return undefined;
};

/** The extension entry next to this module in the bundle, or the source in a dev run. */
const resolveHostModuleUrl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const candidate of ["./extensionHost.mjs", "../extensionHost.mjs", "../extensionHost.ts"]) {
    const url = new URL(candidate, import.meta.url);
    if (yield* fs.exists(NodeURL.fileURLToPath(url)).pipe(Effect.orElseSucceed(() => false))) {
      return url.href;
    }
  }
  return undefined;
});

/**
 * What `activate` must return. The channels are nominal: a plugin is JavaScript, and whatever it
 * fails with is caught as a cause.
 */
const isActivation = (
  value: unknown,
): value is Effect.Effect<unknown, Error, Scope.Scope | McpServer.McpServer> =>
  Effect.isEffect(value);

let hostResolutionRegistered = false;

/** Maps the bare specifier to the extension entry for every module Node loads from now on. */
const registerHostResolution = (hostModuleUrl: string) => {
  if (hostResolutionRegistered) return;
  hostResolutionRegistered = true;
  NodeModule.registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === HOST_SPECIFIER
        ? { url: hostModuleUrl, shortCircuit: true }
        : nextResolve(specifier, context),
  });
};

const make = Effect.fn("PluginLoader.make")(function* (bundled: BundledPlugins) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services: ExtensionContract.Services = {
    threads: yield* ThreadManagementService.ThreadManagementService,
    projects: yield* ProjectService.ProjectService,
    ui: yield* ExtensionUi.ExtensionUi,
    random: yield* SecureRandom.SecureRandom,
  };
  // Everything the server provided to this layer, for the plugins to run with.
  const context = yield* Effect.context<McpServer.McpServer>();
  const pluginsDir = path.join(config.baseDir, "plugins");
  const records = new Map<string, PluginRecord>();
  const servedEffect = parseVersion(effectPackage.version);
  if (servedEffect === undefined)
    return yield* Effect.die(
      new Error(`todo: the server's Effect ${effectPackage.version} is not a version x.y.z`),
    );

  const hostModuleUrl = yield* resolveHostModuleUrl;
  if (hostModuleUrl === undefined) {
    yield* Effect.logWarning("extension entry not found; extensions cannot import it", {
      loader: import.meta.url,
    });
  } else {
    registerHostResolution(hostModuleUrl);
  }

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const isBundled = (name: string) => Object.hasOwn(bundled, name);

  const installedNames = fs.readDirectory(pluginsDir).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((entries) =>
      Effect.filter(
        entries.filter((entry) => SEGMENT_PATTERN.test(entry) && !isBundled(entry)),
        (entry) => isDirectory(path.join(pluginsDir, entry)),
      ),
    ),
  );

  /**
   * Runs `activate` in a scope of its own, closed again if activation fails, after making the
   * plugin's data directory. `hostFor` builds its argument from the contract and the route setter.
   */
  const activateIn = Effect.fn("PluginLoader.activateIn")(function* (
    name: string,
    activate: unknown,
    hostFor: (extension: ExtensionHost, serve: PluginHost["serve"]) => unknown,
  ) {
    if (typeof activate !== "function") {
      return yield* new PluginActivateError({
        plugin: name,
        cause: new Error("its module does not export activate"),
      });
    }
    const dataDir = path.join(config.stateDir, "plugins", name);
    yield* fs
      .makeDirectory(dataDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new PluginActivateError({ plugin: name, cause })));
    // Published only once activation succeeds, so a plugin that serves and then fails serves nothing.
    let route: PluginRouteHandler | undefined;
    const serve: PluginHost["serve"] = (handler) =>
      Effect.sync(() => {
        route = handler;
      });
    const host = hostFor(ExtensionContract.make(name, dataDir, context, services), serve);
    const scope = yield* Scope.make();
    // What it published goes with the activation, a failed one's too.
    yield* Scope.addFinalizer(scope, services.ui.drop(name));
    yield* Effect.suspend(() => {
      const activated: unknown = activate(host);
      return isActivation(activated)
        ? activated
        : Effect.die(new Error("activate did not return an Effect"));
    }).pipe(
      Scope.provide(scope),
      Effect.provide(context),
      // The activation's failure is the one reported; a finalizer failing as it closes is logged.
      Effect.catchCause((cause) =>
        Scope.close(scope, Exit.void).pipe(
          Effect.catchCause((closing) =>
            Effect.logWarning("plugin finalizer failed", { name, cause: Cause.pretty(closing) }),
          ),
          Effect.andThen(new PluginActivateError({ plugin: name, cause: Cause.squash(cause) })),
        ),
      ),
    );
    const loadedAt = DateTime.formatIso(yield* DateTime.now);
    return { scope, loadedAt, route } satisfies Running;
  });

  /** Records the outcome of loading `name`. */
  const settle = Effect.fn("PluginLoader.settle")(function* (
    name: string,
    kind: PluginStatus["kind"],
    version: string | undefined,
    attempt: Effect.Effect<Running, PluginLoadError>,
  ) {
    const outcome = yield* Effect.exit(attempt);
    if (Exit.isSuccess(outcome)) {
      const running = outcome.value;
      records.set(name, {
        status: {
          name,
          version,
          kind,
          status: "loaded",
          error: undefined,
          loadedAt: running.loadedAt,
        },
        running,
      });
      return yield* Effect.logInfo("plugin loaded", { name, kind, version });
    }
    const error = Cause.squash(outcome.cause) as PluginLoadError;
    const described = describeLoadError(error);
    records.set(name, {
      status: {
        name,
        version: (error._tag === "PluginRefusedError" ? error.version : undefined) ?? version,
        kind,
        status: error._tag === "PluginRefusedError" ? "refused" : "failed",
        error: described,
        loadedAt: undefined,
      },
      running: undefined,
    });
    yield* Effect.logWarning("plugin did not load", { name, kind, error: described });
  });

  const refused = (name: string, reason: string, version?: string) =>
    new PluginRefusedError({ plugin: name, reason, ...(version === undefined ? {} : { version }) });

  /** The manifest of `name`, if this server serves what it names. Nothing of the extension runs. */
  const admit = Effect.fn("PluginLoader.admit")(function* (name: string) {
    const dir = path.join(pluginsDir, name);
    const text = yield* fs.readFileString(path.join(dir, "extension.json")).pipe(Effect.option);
    if (Option.isNone(text)) {
      return yield* refused(
        name,
        (yield* exists(path.join(dir, "builds")))
          ? "it is a plugin of the retired form (builds/, no extension.json); rebuild it as an extension"
          : "it has no extension.json",
      );
    }
    const manifest = yield* decodeManifest(text.value).pipe(
      Effect.mapError((error) =>
        refused(name, `its extension.json does not decode: ${error.message}`),
      ),
    );
    const effect = effectRefusal(manifest.effect, servedEffect);
    if (effect !== undefined) return yield* refused(name, effect, manifest.version);
    if (manifest.contract !== CONTRACT)
      return yield* refused(
        name,
        `it was built against contract ${manifest.contract}, and this server serves ${CONTRACT}`,
        manifest.version,
      );
    return manifest;
  });

  /**
   * Loads one installed extension: the one function an install calls too, for a name that is not
   * running, so an install takes effect at once.
   */
  const loadInstalled = Effect.fn("PluginLoader.loadInstalled")(function* (name: string) {
    if (records.get(name)?.running !== undefined)
      return yield* Effect.die(
        new Error(`todo: "${name}" is running; replacing a running extension takes a restart`),
      );
    const manifest = yield* admit(name).pipe(
      Effect.tapError((error) => settle(name, "installed", undefined, Effect.fail(error))),
      Effect.option,
    );
    if (Option.isNone(manifest)) return;
    const url = NodeURL.pathToFileURL(path.join(pluginsDir, name, "main.mjs")).href;
    yield* settle(
      name,
      "installed",
      manifest.value.version,
      Effect.tryPromise({
        try: () => import(url) as Promise<{ readonly activate?: unknown }>,
        catch: (cause) => new PluginImportError({ plugin: name, cause }),
      }).pipe(
        Effect.flatMap((module) => activateIn(name, module.activate, (extension) => extension)),
      ),
    );
  });

  const loadBundled = (name: string, load: BundledPlugins[string]) =>
    settle(
      name,
      "bundled",
      packageJson.version,
      Effect.tryPromise({
        try: load,
        catch: (cause) => new PluginImportError({ plugin: name, cause }),
      }).pipe(
        Effect.flatMap((module) =>
          activateIn(name, module.activate, (extension, serve) => ({
            name,
            context,
            serve,
            extension,
          })),
        ),
      ),
    );

  yield* Effect.forEach(Object.entries(bundled), ([name, load]) => loadBundled(name, load), {
    discard: true,
  });
  yield* Effect.forEach(yield* installedNames, loadInstalled, { discard: true });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      records.values(),
      (entry) =>
        entry.running === undefined ? Effect.void : Scope.close(entry.running.scope, Exit.void),
      { discard: true },
    ),
  );

  return PluginLoader.of({
    list: Effect.sync(() => [...records.keys()].sort().map((name) => records.get(name)!.status)),
    route: (name) => records.get(name)?.running?.route,
  });
});

/** The loader over `bundled`, the plugins compiled into the server (`bundled.ts`); tests pass their own. */
export const layer = (bundled: BundledPlugins) => Layer.effect(PluginLoader, make(bundled));
