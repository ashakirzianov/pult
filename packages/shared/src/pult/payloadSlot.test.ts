// @effect-diagnostics nodeBuiltinImport:off - builds real slot layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";

import {
  deployStagedPayload,
  PayloadSlotError,
  readPayloadSlot,
  resolveServedClientDir,
  rollBackPayload,
  stagePayloadBuild,
} from "./payloadSlot.ts";

const makeSlot = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pult-slot-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const stageClient = (slotDir: string, buildId: string, html = buildId) =>
  stagePayloadBuild(slotDir, buildId, (buildDir) =>
    Effect.sync(() => {
      NodeFS.mkdirSync(NodePath.join(buildDir, "client"));
      NodeFS.writeFileSync(NodePath.join(buildDir, "client", "index.html"), html);
    }),
  );

const readServedHtml = (slotDir: string) =>
  NodeFS.readFileSync(NodePath.join(slotDir, "current", "client", "index.html"), "utf8");

const ids = (slot: Effect.Success<ReturnType<typeof readPayloadSlot>>) => ({
  staging: Option.getOrNull(slot.staging),
  current: Option.getOrNull(slot.current),
  previous: Option.getOrNull(slot.previous),
});

describe("payloadSlot", () => {
  it.effect("staging a build never touches current", () =>
    Effect.gen(function* () {
      const slotDir = yield* makeSlot;
      yield* stageClient(slotDir, "b1");
      yield* deployStagedPayload(slotDir);
      yield* stageClient(slotDir, "b2");

      assert.deepStrictEqual(ids(yield* readPayloadSlot(slotDir)), {
        staging: "b2",
        current: "b1",
        previous: null,
      });
      assert.strictEqual(readServedHtml(slotDir), "b1");
      assert.isFalse(NodeFS.existsSync(NodePath.join(slotDir, "builds", ".b2.partial")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("deploy moves current to previous, and roll back swaps them", () =>
    Effect.gen(function* () {
      const slotDir = yield* makeSlot;
      yield* stageClient(slotDir, "b1");
      assert.isTrue(yield* deployStagedPayload(slotDir));
      yield* stageClient(slotDir, "b2");
      assert.isTrue(yield* deployStagedPayload(slotDir));
      assert.deepStrictEqual(ids(yield* readPayloadSlot(slotDir)), {
        staging: "b2",
        current: "b2",
        previous: "b1",
      });
      assert.strictEqual(readServedHtml(slotDir), "b2");

      assert.isFalse(yield* deployStagedPayload(slotDir));

      yield* rollBackPayload(slotDir);
      assert.deepStrictEqual(ids(yield* readPayloadSlot(slotDir)), {
        staging: "b2",
        current: "b1",
        previous: "b2",
      });
      assert.strictEqual(readServedHtml(slotDir), "b1");

      yield* rollBackPayload(slotDir);
      assert.strictEqual(readServedHtml(slotDir), "b2");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses what cannot be done", () =>
    Effect.gen(function* () {
      const slotDir = yield* makeSlot;
      const reasonOf = <A, R>(effect: Effect.Effect<A, PayloadSlotError | PlatformError, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error._tag === "PayloadSlotError" ? error.reason : error._tag)),
        );

      assert.strictEqual(yield* reasonOf(deployStagedPayload(slotDir)), "nothing-staged");
      assert.strictEqual(yield* reasonOf(rollBackPayload(slotDir)), "no-previous");
      assert.strictEqual(yield* reasonOf(stageClient(slotDir, "../escape")), "invalid-build-id");
      assert.strictEqual(yield* reasonOf(stageClient(slotDir, ".hidden")), "invalid-build-id");
      yield* stageClient(slotDir, "b1");
      assert.strictEqual(yield* reasonOf(stageClient(slotDir, "b1", "other")), "build-exists");
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(slotDir, "builds", "b1", "client", "index.html"), "utf8"),
        "b1",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serves the override only while it holds an index.html", () =>
    Effect.gen(function* () {
      const slotDir = yield* makeSlot;
      const override = NodePath.join(slotDir, "current", "client");

      assert.strictEqual(yield* resolveServedClientDir(override, "/bundled"), "/bundled");
      assert.strictEqual(yield* resolveServedClientDir(undefined, "/bundled"), "/bundled");

      yield* stageClient(slotDir, "b1");
      yield* deployStagedPayload(slotDir);
      assert.strictEqual(yield* resolveServedClientDir(override, "/bundled"), override);

      yield* stagePayloadBuild(slotDir, "broken", (buildDir) =>
        Effect.sync(() => NodeFS.mkdirSync(NodePath.join(buildDir, "client"))),
      );
      yield* deployStagedPayload(slotDir);
      assert.strictEqual(yield* resolveServedClientDir(override, "/bundled"), "/bundled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
