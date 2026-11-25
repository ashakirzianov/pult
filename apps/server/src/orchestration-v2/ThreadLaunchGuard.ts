// Pult: a hook point on a fresh thread launch (docs/internals/plugins.md, Hook points). A plugin
// registers at most one guard in its activation's scope; `ThreadLaunchService.launch` runs a launch
// with no receipt through it, so the guard may refuse it or run it under a lock of its own. A launch
// already accepted replays unguarded. With no guard registered, launches are upstream's.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ThreadManagement from "./ThreadManagementService.ts";
import type {
  ThreadLaunchError,
  ThreadLaunchInput,
  ThreadLaunchResult,
} from "./ThreadLaunchService.ts";

/** A guard's refusal; the launch fails with a `ThreadLaunchError` of operation `guard` that says it. */
export class ThreadLaunchRefusal extends Schema.TaggedError<ThreadLaunchRefusal>()(
  "ThreadLaunchRefusal",
  { message: Schema.String },
) {}

export const isThreadLaunchRefusal = Schema.is(ThreadLaunchRefusal);

type LaunchError =
  | ThreadLaunchError
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError;

/** Runs `launch`, the rest of a fresh launch, or refuses it. */
export type Guard = (
  input: ThreadLaunchInput,
  launch: Effect.Effect<ThreadLaunchResult, LaunchError>,
) => Effect.Effect<ThreadLaunchResult, LaunchError | ThreadLaunchRefusal>;

export class ThreadLaunchGuard extends Context.Service<
  ThreadLaunchGuard,
  {
    /** Holds `guard` until the caller's scope closes; a second registration while one is held is a defect. */
    readonly register: (guard: Guard) => Effect.Effect<void, never, Scope.Scope>;
    readonly current: Effect.Effect<Guard | undefined>;
  }
>()("t3/orchestration-v2/ThreadLaunchGuard") {}

export const make = Effect.sync(() => {
  let held: Guard | undefined;
  return ThreadLaunchGuard.of({
    register: Effect.fn("ThreadLaunchGuard.register")((guard: Guard) =>
      Effect.acquireRelease(
        Effect.suspend(() =>
          held === undefined
            ? Effect.sync(() => {
                held = guard;
              })
            : Effect.die(new Error("A thread launch guard is registered already.")),
        ),
        () =>
          Effect.sync(() => {
            if (held === guard) held = undefined;
          }),
      ),
    ),
    current: Effect.sync(() => held),
  });
});

export const layer = Layer.effect(ThreadLaunchGuard, make);
