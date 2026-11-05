// Stands in for `apps/web`'s `src/localApi.ts` (`../../stubs.ts`): upstream's
// local API, but the client settings it reads have the composer's context
// window meter always on, whether from the browser's storage or, in Pult.app,
// the desktop bridge's. Upstream defaults it off behind a toggle on its settings
// page, which Pult does not have; a Pult setting for it would be the workbench's.
import { DEFAULT_CLIENT_SETTINGS, type LocalApi } from "@t3tools/contracts";

import { createLocalApi as createUpstreamLocalApi } from "~/localApi";

let cachedApi: LocalApi | undefined;

export function createLocalApi(): LocalApi {
  const upstream = createUpstreamLocalApi();
  return {
    ...upstream,
    persistence: {
      ...upstream.persistence,
      getClientSettings: async () => ({
        ...((await upstream.persistence.getClientSettings()) ?? DEFAULT_CLIENT_SETTINGS),
        contextWindowMeterEnabled: true,
      }),
    },
  };
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  cachedApi ??= createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}
