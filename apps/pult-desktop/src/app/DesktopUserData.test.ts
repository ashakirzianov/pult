import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([
  { isDevelopment: false, expected: "/profiles/pult" },
  { isDevelopment: true, expected: "/profiles/pult-dev" },
])("resolves Pult's own profile (development: $isDevelopment)", ({ isDevelopment, expected }) =>
  Effect.gen(function* () {
    const userData = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment,
      platform: "win32",
    });
    assert.equal(userData, expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);
