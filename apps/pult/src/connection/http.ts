import { EnvironmentSupervisor, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection } from "./connection.ts";

/**
 * Runs `use` with the environment's prepared connection, for a request to its
 * HTTP API through `client-runtime`'s `executeAuthenticatedEnvironmentHttpRequest`,
 * as `peerPairingCode.ts` sends one, with no signer: Pult runs no T3 Connect,
 * so every connection it prepares authorizes with a bearer, never DPoP.
 */
export function withPreparedConnection<A, E>(
  environmentId: string,
  use: (prepared: PreparedConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> {
  return connection.run(
    environmentId,
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId,
          message: `${supervisor.target.label} is not connected.`,
        });
      }
      return yield* use(prepared.value);
    }),
  );
}
