import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@t3tools/contracts";
import { VcsRepositoryDetectionError, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";
import type * as VcsWorkflow from "./VcsWorkflow.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
// Detection costs three git processes per cwd; cached hits still stat disk, so TTL bounds only undetectable changes.
const DETECTION_CACHE_TTL = Duration.minutes(5);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
  /** Pult: a registered kind's routed calls (`register`); undefined for git's. */
  readonly workflow?: VcsWorkflow.VcsWorkflow;
}

/** Pult: the kinds a plugin may register: the contracts' literal less upstream's, `monore` alone. */
export type RegisteredVcsKind = Exclude<VcsDriverKind, "git" | "jj" | "unknown">;

/**
 * Pult: a VCS kind a plugin registers (docs/internals/plugins.md, Hook points): its driver, which
 * finds a checkout's root with no process, the marker file at that root, and the calls
 * `GitWorkflowService` and `ReviewService` route to it.
 */
export interface VcsDriverRegistration {
  readonly kind: RegisteredVcsKind;
  readonly marker: string;
  readonly driver: VcsDriver.VcsDriver["Service"];
  readonly workflow: VcsWorkflow.VcsWorkflow;
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
    /**
     * Pult: holds `registration` until the caller's scope closes; a second one while one is held
     * is a defect. Registering and its release drop every detection, those in flight included.
     */
    readonly register: (
      registration: VcsDriverRegistration,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
  };
  // Pult: the kind a plugin registered (`register`, `pult/decisions`, `vcs-driver-seam`). One slot,
  // since `RegisteredVcsKind` is one literal; which of two kinds is nearest is not decided.
  let registered: VcsDriverRegistration | undefined;

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = kind === registered?.kind ? registered.driver : drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    // Status, review and source control show a repository Git cannot read as none at all.
    // Checkpoints need the failure, so CheckpointStore asks the driver directly.
    const repository = yield* driver.detectRepository(cwd).pipe(
      Effect.catchTags({
        VcsProcessExitError: (error) =>
          error.operation === GitVcsDriver.WORK_TREE_PROBE_OPERATION
            ? Effect.succeed(null)
            : Effect.fail(error),
      }),
    );
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
      ...(kind === registered?.kind ? { workflow: registered.workflow } : {}),
    } satisfies VcsDriverHandle;
  });

  // Pult: a registered kind's checkout around cwd, unless `.git` is nearer; `.git` beside its marker
  // fails (`pult/decisions`, `vcs-detection-nearest`).
  const nearestRegistered = Effect.fn("VcsDriverRegistry.nearestRegistered")(function* (
    cwd: string,
  ) {
    const registration = registered;
    if (registration === undefined) return null;
    const repository = yield* registration.driver.detectRepository(cwd);
    if (repository === null) return null;
    const fail = (detail: string, cause?: unknown) =>
      new VcsRepositoryDetectionError({
        operation: "VcsDriverRegistry.nearestRegistered",
        cwd,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    // Upward from cwd, as the driver looked; its root is real, so each folder is compared real.
    let folder = path.resolve(cwd);
    while (true) {
      const [real, hasGit] = yield* Effect.all([
        // A folder not on disk is no root; the driver walked past it too.
        fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => null)),
        fileSystem
          .exists(path.join(folder, ".git"))
          .pipe(Effect.mapError((cause) => fail("Could not inspect a .git entry.", cause))),
      ]);
      if (real === repository.rootPath) {
        if (hasGit) {
          return yield* fail(
            `${folder} holds both a ${registration.marker} marker and .git; remove one of them.`,
          );
        }
        return {
          kind: registration.kind,
          repository,
          driver: registration.driver,
          workflow: registration.workflow,
        } satisfies VcsDriverHandle;
      }
      if (hasGit) return null;
      const parent = path.dirname(folder);
      if (parent === folder) {
        return yield* fail(
          `The ${registration.kind} checkout at ${repository.rootPath} is not above ${cwd}.`,
        );
      }
      folder = parent;
    }
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    const nearest = yield* nearestRegistered(input.cwd);
    if (nearest !== null) return nearest;
    return yield* detectWithDriver("git", git, input.cwd);
  });

  // Symlinks can put cwd outside root; then inspect cwd alone.
  const foldersBelowRoot = (cwd: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return [cwd];
    return Array.from({ length: relative.split(path.sep).length }, (_, levelsUp) =>
      path.resolve(cwd, ...Array<string>(levelsUp).fill("..")),
    );
  };

  // Pult: a registered kind's marker appearing below the root moves the nearest repository too.
  const readDiskState = (cwd: string, repository: VcsRepositoryIdentity) =>
    Effect.all({
      gitEntries: Effect.forEach(
        foldersBelowRoot(cwd, repository.rootPath).flatMap((folder) => [
          path.join(folder, ".git"),
          ...(registered === undefined ? [] : [path.join(folder, registered.marker)]),
        ]),
        (entry) => fileSystem.exists(entry),
      ),
      repositoryOnDisk: Effect.forEach(
        repository.metadataPath === null
          ? [cwd]
          : [cwd, path.resolve(cwd, repository.metadataPath)],
        (target) => fileSystem.exists(target),
      ).pipe(Effect.map((results) => results.every(Boolean))),
    }).pipe(Effect.orElseSucceed(() => null));

  const detectionCache = yield* Cache.makeWith<
    string,
    { readonly handle: VcsDriverHandle; readonly gitEntries: ReadonlyArray<boolean> } | null,
    VcsError
  >(
    (key) =>
      Effect.gen(function* () {
        const input = parseDetectionCacheKey(key);
        const handle = yield* detectResolvedKind(input);
        if (handle === null) return null;
        const disk = yield* readDiskState(input.cwd, handle.repository);
        return { handle, gitEntries: disk?.gitEntries ?? [] };
      }),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) => (detected === null ? Duration.zero : DETECTION_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      const key = detectionCacheKey({ cwd: input.cwd, requestedKind });
      const cached = yield* Cache.get(detectionCache, key);
      if (cached === null) return null;
      const disk = yield* readDiskState(input.cwd, cached.handle.repository);
      if (
        disk?.repositoryOnDisk &&
        disk.gitEntries.length === cached.gitEntries.length &&
        disk.gitEntries.every((exists, index) => exists === cached.gitEntries[index])
      ) {
        return cached.handle;
      }
      yield* Cache.invalidate(detectionCache, key);
      return (yield* Cache.get(detectionCache, key))?.handle ?? null;
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  const register: VcsDriverRegistry["Service"]["register"] = Effect.fn(
    "VcsDriverRegistry.register",
  )((registration) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (registered !== undefined) {
          return Effect.die(new Error(`A ${registered.kind} VCS driver is registered already.`));
        }
        registered = registration;
        return Cache.invalidateAll(detectionCache);
      }),
      () =>
        Effect.suspend(() => {
          registered = undefined;
          return Cache.invalidateAll(detectionCache);
        }),
    ),
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
    register,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
