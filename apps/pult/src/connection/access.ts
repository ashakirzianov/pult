import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  applyAuthAccessStreamEvent,
  EMPTY_AUTH_ACCESS_SNAPSHOT,
} from "@t3tools/client-runtime/state/auth";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import {
  type AuthAccessSnapshot,
  type AuthSessionId,
  AuthStandardClientScopes,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { connection } from "./connection.ts";
import { withPreparedConnection } from "./http.ts";

// An environment's access (xaxis `pult/issues/pair-device`): the pairing
// links it has outstanding and the clients it has authorized, which the
// settings page lists, and the HTTP calls minting and revoking them, each
// gated by the server on the session's scopes (`access:write` to mint and
// revoke, `access:read` to list).

const TIMEOUT_MS = 8_000;

type AuthRequest<A, E> = Pick<
  Parameters<typeof executeAuthenticatedEnvironmentHttpRequest<"auth", A, E, never>>[0],
  "url" | "request"
>;

/** A POST to the server's auth API with the environment's prepared connection (`http.ts`). */
function authPost<A, E>(environmentId: string, request: AuthRequest<A, E>): Promise<A> {
  return withPreparedConnection(environmentId, (prepared) =>
    executeAuthenticatedEnvironmentHttpRequest({
      ...request,
      prepared,
      signer: Option.none(),
      group: "auth",
      method: "POST",
      timeoutMs: TIMEOUT_MS,
    }),
  );
}

/** A pairing link minted for another device: its id among the outstanding links, the one-use code, and when it expires (epoch ms). */
export interface MintedPairing {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: number;
}

/**
 * Mints a pairing credential on the environment with upstream's standard
 * client scopes, which the session must hold itself; its label, when given,
 * names the link and then the client that redeems it.
 */
export async function mintPairing(environmentId: string, label?: string): Promise<MintedPairing> {
  const minted = await authPost(environmentId, {
    url: (urls) => urls.pairingCredential(),
    request: ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: { scopes: AuthStandardClientScopes, ...(label === undefined ? {} : { label }) },
      }),
  });
  return {
    id: minted.id,
    credential: minted.credential,
    expiresAt: DateTime.toEpochMillis(minted.expiresAt),
  };
}

export async function revokePairingLink(environmentId: string, id: string): Promise<void> {
  await authPost(environmentId, {
    url: (urls) => urls.revokePairingLink(),
    request: ({ client, headers }) => client.revokePairingLink({ headers, payload: { id } }),
  });
}

export async function revokeClient(environmentId: string, sessionId: AuthSessionId): Promise<void> {
  await authPost(environmentId, {
    url: (urls) => urls.revokeClient(),
    request: ({ client, headers }) => client.revokeClient({ headers, payload: { sessionId } }),
  });
}

/** The environment's access as its stream last stood, or why it cannot be read (a session without `access:read`, say). */
export type AccessState =
  | { readonly _tag: "snapshot"; readonly snapshot: AuthAccessSnapshot }
  | { readonly _tag: "failed"; readonly message: string };

/**
 * Follows the environment's access (`subscribeAuthAccess`, projected as
 * `client-runtime`'s `state/auth.ts` does), across its reconnects, each
 * subscription opening with a whole snapshot, until the returned function
 * stops it; a failure ends it.
 */
export function followAccess(
  environmentId: string,
  onState: (state: AccessState) => void,
): () => void {
  const stream: Stream.Stream<AccessState, never, EnvironmentSupervisor.EnvironmentSupervisor> =
    subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
      Stream.mapAccum(
        () => EMPTY_AUTH_ACCESS_SNAPSHOT,
        (current, event) => {
          const next = applyAuthAccessStreamEvent(current, event);
          return [next, [{ _tag: "snapshot", snapshot: next } as const]];
        },
      ),
      Stream.catchCause((cause) =>
        Stream.succeed({ _tag: "failed", message: messageOf(Cause.squash(cause)) } as const),
      ),
    );
  return connection.follow(environmentId, stream, onState);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
