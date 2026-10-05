/**
 * The server part's HTTP routes, reverse-proxied under `/api/pult/part/` on
 * the host's origin and behind its auth, so remote and browser clients reach
 * them the way they reach the host, with no cap on time or size. The part
 * sees the path below the prefix and `authorization: Bearer <secret>`, never
 * the client's credentials. Copied in shape from `device/DeviceHubProxy.ts`.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as PultPart from "./PultPart.ts";

/** Hop-by-hop headers and the client's own credentials, which must not reach the part. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
]);

/** The client decodes the body, so its encoding and length no longer hold. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/**
 * Cookie for browser sessions, or a `wsTicket` for bearer clients where a
 * header cannot be set (WebSocket, `<img>`), as the `/ws` upgrade does.
 */
const authenticate = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
  });

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, secret: string) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${secret}`;
  return headers;
};

const pumpFrames = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyWebSocket = Effect.fn("PultPartProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  secret: string,
) {
  const client = yield* request.upgrade;
  // A WebSocket handshake cannot carry headers from here, so the secret
  // travels as the subprotocol the part checks.
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    protocols: [`pult-part.${secret}`],
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("PultPartProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  secret: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const response = yield* httpClient.execute(
    HttpClientRequest.make(method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders(forwardHeaders(request, secret)),
      method === "GET" || method === "HEAD"
        ? (self) => self
        : HttpClientRequest.bodyStream(request.stream),
    ),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const upgrade = isWebSocketUpgrade(request);
  const readOnly = !upgrade && (request.method === "GET" || request.method === "HEAD");
  yield* authenticate(readOnly ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope);
  const part = yield* PultPart.PultPart;
  const state = yield* SubscriptionRef.get(part.state);
  if (state._tag !== "Ready") {
    return HttpServerResponse.text("Pult's server part is not running", { status: 503 });
  }
  // The ticket authenticated this request and must not travel on.
  const search = new URLSearchParams(url.value.search);
  search.delete("wsTicket");
  const path = url.value.pathname.slice(PultPart.PART_ROUTE_PREFIX.length) || "/";
  const upstreamPath = `${path}${search.size > 0 ? `?${search.toString()}` : ""}`;
  return upgrade
    ? yield* proxyWebSocket(
        request,
        `${state.origin.replace(/^http/, "ws")}${upstreamPath}`,
        state.secret,
      )
    : yield* proxyHttp(request, `${state.origin}${upstreamPath}`, state.secret);
});

export const routeLayer = HttpRouter.add("*", `${PultPart.PART_ROUTE_PREFIX}/*`, handler);
