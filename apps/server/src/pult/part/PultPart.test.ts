import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import * as PultPart from "./PultPart.ts";

// Echoes its handshake, its build and the forwarded authorization back over
// HTTP. A build whose directory holds a `hang` file never reports its port.
const FAKE_PART = `
import * as fs from "node:fs";
import * as http from "node:http";
const handshake = JSON.parse(fs.readFileSync(3, "utf8"));
if (fs.existsSync("hang")) {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    response.end(JSON.stringify({ build: process.cwd(), handshake, authorization: request.headers.authorization ?? null }));
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeSync(4, JSON.stringify({ port: server.address().port }) + "\\n");
  });
}
`;

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const makeAuth = (issued: Array<ReadonlyArray<string>>, revoked: Array<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueSession: (input) =>
      Effect.sync(() => {
        issued.push(input?.scopes ?? []);
        const sessionId = AuthSessionId.make(`session-${issued.length}`);
        return {
          sessionId,
          token: `token-${issued.length}`,
          method: "bearer-access-token" as const,
          scopes: input?.scopes ?? [],
          subject: input?.subject ?? "",
          client: { deviceType: "bot" as const },
          expiresAt: DateTime.makeUnsafe(0),
        };
      }),
    revokeSession: (sessionId) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  });

/** A payload slot in a temp home: `builds/<id>/part/main.mjs`, and links into it. */
const makeSlot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "pult-part-test-" });
  const slot = path.join(home, "payload");
  const addBuild = (id: string, options: { readonly hang?: boolean } = {}) =>
    Effect.gen(function* () {
      const partDir = path.join(slot, "builds", id, "part");
      yield* fs.makeDirectory(partDir, { recursive: true });
      yield* fs.writeFileString(path.join(partDir, "main.mjs"), FAKE_PART);
      if (options.hang) yield* fs.writeFileString(path.join(partDir, "hang"), "");
      return yield* fs.realPath(partDir);
    });
  const point = (link: "current" | "previous", id: string) =>
    Effect.gen(function* () {
      const temporary = path.join(slot, `.${link}.next`);
      yield* fs.symlink(path.join("builds", id), temporary);
      yield* fs.rename(temporary, path.join(slot, link));
    });
  yield* fs.makeDirectory(slot, { recursive: true });
  return {
    home,
    partDir: path.join(slot, "current", "part"),
    partFallbackDir: path.join(slot, "previous", "part"),
    addBuild,
    point,
  };
});

const runPart = (
  slot: { readonly home: string; readonly partDir: string; readonly partFallbackDir: string },
  auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>,
) =>
  PultPart.make({ readyTimeout: "1 second", pollInterval: "50 millis" }).pipe(
    Effect.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({
            ...config,
            partDir: slot.partDir,
            partFallbackDir: slot.partFallbackDir,
          })),
        ),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), slot.home))),
    ),
    Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
    Effect.provide(auth),
  );

const awaitState = (
  part: PultPart.PultPart["Service"],
  predicate: (state: PultPart.PultPartState) => boolean,
) =>
  SubscriptionRef.changes(part.state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const readyIn = (dir: string) => (state: PultPart.PultPartState) =>
  state._tag === "Ready" && state.dir === dir;

const Echo = Schema.Struct({
  build: Schema.String,
  authorization: Schema.NullOr(Schema.String),
  handshake: Schema.Record(Schema.String, Schema.String),
});

const fetchPart = (state: PultPart.PultPartState) =>
  state._tag !== "Ready"
    ? Effect.die(`part is ${state._tag}`)
    : HttpClient.get(state.origin, {
        headers: { authorization: `Bearer ${state.secret}` },
      }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Echo)),
        Effect.provide(FetchHttpClient.layer),
        Effect.orDie,
      );

it.live("runs the live build's part and hands it the host bearer on fd 3", () =>
  Effect.gen(function* () {
    const slot = yield* makeSlot;
    const live = yield* slot.addBuild("a");
    yield* slot.point("current", "a");
    const issued: Array<ReadonlyArray<string>> = [];
    const part = yield* runPart(slot, makeAuth(issued, []));
    const gate = yield* PultPart.PultPartGate;

    const ready = yield* awaitState(part, readyIn(live));
    const echoed = yield* fetchPart(ready);
    expect(echoed.build).toBe(live);
    expect(echoed.handshake).toMatchObject({
      serverUrl: "http://127.0.0.1:43123",
      token: "token-1",
      routePrefix: PultPart.PART_ROUTE_PREFIX,
    });
    expect(echoed.handshake.dataDir).toMatch(/userdata[/\\]part$/);
    expect(echoed.authorization).toBe(`Bearer ${ready._tag === "Ready" ? ready.secret : ""}`);
    expect(issued).toEqual([AuthStandardClientScopes]);
    // The tools forwarder settles the gate, not the supervisor.
    expect(yield* gate.await.pipe(Effect.timeoutOption("50 millis"))).toEqual(Option.none());
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, PultPart.gateLayer)), Effect.scoped),
);

it.live("restarts the part when a deploy repoints current, revoking the old bearer", () =>
  Effect.gen(function* () {
    const slot = yield* makeSlot;
    const first = yield* slot.addBuild("a");
    const second = yield* slot.addBuild("b");
    yield* slot.point("current", "a");
    const revoked: Array<string> = [];
    const part = yield* runPart(slot, makeAuth([], revoked));

    yield* awaitState(part, readyIn(first));
    yield* slot.point("previous", "a");
    yield* slot.point("current", "b");
    const ready = yield* awaitState(part, readyIn(second));
    expect((yield* fetchPart(ready)).handshake.token).toBe("token-2");
    expect(revoked).toEqual(["session-1"]);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, PultPart.gateLayer)), Effect.scoped),
);

it.live("falls back to the previous build's part when the live one does not come up", () =>
  Effect.gen(function* () {
    const slot = yield* makeSlot;
    const previous = yield* slot.addBuild("a");
    yield* slot.addBuild("b", { hang: true });
    yield* slot.point("previous", "a");
    yield* slot.point("current", "b");
    const part = yield* runPart(slot, makeAuth([], []));

    const ready = yield* awaitState(part, readyIn(previous));
    expect((yield* fetchPart(ready)).build).toBe(previous);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, PultPart.gateLayer)), Effect.scoped),
);

it.live("settles the gate when there is no part to run", () =>
  Effect.gen(function* () {
    const slot = yield* makeSlot;
    const part = yield* runPart(slot, makeAuth([], []));
    const gate = yield* PultPart.PultPartGate;

    yield* gate.await;
    expect(yield* SubscriptionRef.get(part.state)).toEqual({ _tag: "Absent" });
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, PultPart.gateLayer)), Effect.scoped),
);
