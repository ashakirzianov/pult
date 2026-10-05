/**
 * What passes between the server and Pult's server part: the handshake the
 * part reads from fd 3, the line it answers with on fd 4, and what a call the
 * server forwards carries. The part's directory and entry are in
 * `payloadSlot.ts`.
 */
import * as Schema from "effect/Schema";

/** Where the server reverse-proxies the part's HTTP routes, stripped before forwarding. */
export const PART_ROUTE_PREFIX = "/api/pult/part";

/** The `_meta` key a forwarded MCP tool call carries its caller under. */
export const PART_CALLER_META_KEY = "pult/caller";

/** The file descriptor the part reads its handshake from, as one JSON line. */
export const PART_HANDSHAKE_FD = 3;

/** The file descriptor the part writes `PartReady` to, as one JSON line, once it serves. */
export const PART_READY_FD = 4;

export const PartHandshake = Schema.Struct({
  /** The server's loopback origin, for its ordinary client API. */
  serverUrl: Schema.String,
  /** A bearer for that API, with a paired client's scopes; revoked when this run of the part ends. */
  token: Schema.String,
  /**
   * The server presents it on every request it forwards: as
   * `authorization: Bearer <secret>`, and on a WebSocket as the subprotocol
   * `pult-part.<secret>`, which the part must accept.
   */
  secret: Schema.String,
  /** The part's own state directory. */
  dataDir: Schema.String,
  routePrefix: Schema.String,
});
export type PartHandshake = typeof PartHandshake.Type;

/** The part serves plain MCP at `/mcp` and its routes on this loopback port. */
export const PartReady = Schema.Struct({ port: Schema.Int });
export type PartReady = typeof PartReady.Type;

/** Who called a forwarded tool. */
export const PartCaller = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  providerSessionId: Schema.String,
  providerInstanceId: Schema.String,
});
export type PartCaller = typeof PartCaller.Type;
