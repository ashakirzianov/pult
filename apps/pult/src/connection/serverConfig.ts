import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { makeEnvironmentServerConfigState } from "@t3tools/client-runtime/state/server";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connection, SERVER_CONFIG_OPTIONS } from "./connection.ts";

/**
 * Hands `publish` an environment's server config, as the registry's supervisor keeps it live, on
 * the same subscription the session holds (`SERVER_CONFIG_OPTIONS`), which it replays rather than
 * opening another, until the returned function stops it. Every change to the registry entry
 * restarts `followStream`, and so the config's state, empty until the session replays it; the
 * page's cache store keeps nothing to start it from.
 */
export function followServerConfig(
  environmentId: string,
  publish: (config: ServerConfig) => void,
): () => void {
  const fiber = connection.runtime.runFork(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry
        .followStream(
          EnvironmentId.make(environmentId),
          Stream.unwrap(
            makeEnvironmentServerConfigState(SERVER_CONFIG_OPTIONS).pipe(
              Effect.map(SubscriptionRef.changes),
            ),
          ),
        )
        .pipe(
          Stream.runForEach((state) =>
            Effect.sync(() => {
              if (Option.isSome(state)) publish(state.value.config);
            }),
          ),
        );
    }).pipe(Effect.withSpan("Pult.followServerConfig")),
  );
  return () => void Effect.runFork(Fiber.interrupt(fiber));
}
