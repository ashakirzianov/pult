/**
 * Pult's payload slot: `<home>/payload/` holds one directory per build,
 * `builds/<build-id>/`, with the client in `client/` and the server part in
 * `part/`, and three links into `builds/`: `staging`, `current` and
 * `previous`. Agents stage a build; only the human switches it live, from the
 * desktop shell's menu. The server and the shell serve `current/client` on
 * every request, so a switch is one atomic rename; the server notices that
 * `current/part` moved and restarts only the part.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type PayloadLink = "staging" | "current" | "previous";

export interface PayloadSlotState {
  readonly staging: Option.Option<string>;
  readonly current: Option.Option<string>;
  readonly previous: Option.Option<string>;
}

export class PayloadSlotError extends Schema.TaggedError<PayloadSlotError>()("PayloadSlotError", {
  reason: Schema.Literals(["invalid-build-id", "build-exists", "nothing-staged", "no-previous"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const payloadSlotDir = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(home, "payload");
  });

/** Pult's default client directory override: the live build's client. */
export const defaultClientDir = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(home, "payload", "current", "client");
  });

/** The file in a part directory that the server runs with its own Node runtime. */
export const PART_ENTRY_FILE = "main.mjs";

/** Pult's default server part directory: the live build's part. */
export const defaultPartDir = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(home, "payload", "current", "part");
  });

/** Where the server runs the part from when the live build's part does not come up. */
export const fallbackPartDir = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(home, "payload", "previous", "part");
  });

/**
 * The directory to serve the client from right now: the override when it
 * holds an `index.html`, otherwise the bundled client. Checked per request, so
 * a slot that is empty, or a deployed build that lacks its entry point, falls
 * back to the bundled client without a restart.
 */
export const resolveServedClientDir = <Fallback extends string | undefined>(
  override: string | undefined,
  bundled: Fallback,
) =>
  Effect.gen(function* () {
    if (override === undefined) return bundled;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hasEntry = yield* fs
      .exists(path.join(override, "index.html"))
      .pipe(Effect.orElseSucceed(() => false));
    return hasEntry ? override : bundled;
  });

const readLink = (slotDir: string, link: PayloadLink) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readLink(path.join(slotDir, link)).pipe(
      Effect.map((target) => Option.some(path.basename(target))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

export const readPayloadSlot = (
  slotDir: string,
): Effect.Effect<PayloadSlotState, never, FileSystem.FileSystem | Path.Path> =>
  Effect.all({
    staging: readLink(slotDir, "staging"),
    current: readLink(slotDir, "current"),
    previous: readLink(slotDir, "previous"),
  });

// A new link is made beside the old one and renamed over it, so a reader
// sees either the old build or the new one, never a missing link.
const pointLink = (slotDir: string, link: PayloadLink, buildId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const temporary = path.join(slotDir, `.${link}.${process.pid}.${now}`);
    yield* fs.symlink(path.join("builds", buildId), temporary);
    yield* fs
      .rename(temporary, path.join(slotDir, link))
      .pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)));
  });

/**
 * Stages a build: `populate` fills a fresh build directory (the client goes in
 * `client/`, the server part in `part/`), which then becomes `builds/<buildId>` and the target of
 * `staging`. Never touches `current`.
 */
export const stagePayloadBuild = <E, R>(
  slotDir: string,
  buildId: string,
  populate: (buildDir: string) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!BUILD_ID_PATTERN.test(buildId)) {
      return yield* new PayloadSlotError({
        reason: "invalid-build-id",
        detail: `"${buildId}" is not a valid build id.`,
      });
    }
    const buildsDir = path.join(slotDir, "builds");
    const buildDir = path.join(buildsDir, buildId);
    if (yield* fs.exists(buildDir)) {
      return yield* new PayloadSlotError({
        reason: "build-exists",
        detail: `Build ${buildId} is already in ${buildsDir}.`,
      });
    }
    const partialDir = path.join(buildsDir, `.${buildId}.partial`);
    yield* fs.remove(partialDir, { recursive: true, force: true });
    yield* fs.makeDirectory(partialDir, { recursive: true });
    yield* populate(partialDir);
    yield* fs.rename(partialDir, buildDir);
    yield* pointLink(slotDir, "staging", buildId);
    return buildDir;
  });

/**
 * Makes the staged build live: `previous` takes the old `current`, and
 * `current` takes `staging`. Returns `false` when the staged build is already
 * live.
 */
export const deployStagedPayload = (slotDir: string) =>
  Effect.gen(function* () {
    const slot = yield* readPayloadSlot(slotDir);
    if (Option.isNone(slot.staging)) {
      return yield* new PayloadSlotError({
        reason: "nothing-staged",
        detail: "No build is staged.",
      });
    }
    const staged = slot.staging.value;
    if (Option.getOrUndefined(slot.current) === staged) return false;
    if (Option.isSome(slot.current)) {
      yield* pointLink(slotDir, "previous", slot.current.value);
    }
    yield* pointLink(slotDir, "current", staged);
    return true;
  });

/**
 * Makes the previous build live again. `current` and `previous` swap, so a
 * second roll back returns to the build that was rolled back from.
 */
export const rollBackPayload = (slotDir: string) =>
  Effect.gen(function* () {
    const slot = yield* readPayloadSlot(slotDir);
    if (Option.isNone(slot.previous)) {
      return yield* new PayloadSlotError({
        reason: "no-previous",
        detail: "There is no previous build to roll back to.",
      });
    }
    yield* pointLink(slotDir, "current", slot.previous.value);
    if (Option.isSome(slot.current)) {
      yield* pointLink(slotDir, "previous", slot.current.value);
    }
  });
