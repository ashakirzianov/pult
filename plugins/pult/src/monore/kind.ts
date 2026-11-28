// A monore checkout as a VCS kind of the server's (`pult/decisions`, `vcs-driver-seam`): the
// server's driver, marker and calls for it, registered into its `VcsDriverRegistry` for the
// caller's scope, so the server's services read a checkout as one from then on.
import { Effect, MonoreVcsDriver, VcsDriverRegistry } from "../host.ts";

export const register = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  yield* registry.register({
    kind: "monore",
    marker: MonoreVcsDriver.MONORE_MARKER,
    driver: yield* MonoreVcsDriver.makeVcsDriver,
    workflow: yield* MonoreVcsDriver.MonoreVcsDriver,
  });
});
