// The server's Pult plugin, as the page asks it (`plugins/pult`, xaxis
// `pult/design-durable-agent-sleep`): the one file that names its routes,
// apart from the workbench so `node --test src/stars/plugin.test.ts` can run
// it. Today only `about`, which says what the plugin of a server does.

/** The plugin's feature of keeping the Stars: where `about` lists it, the server puts a Star's conversations to sleep and writes their transcripts, and the page does neither. */
export const STARS_FEATURE = "stars";

const ABOUT_PATH = "/api/plugins/pult/about";

/** The names `about` answers, `{ features: string[] }`; null for anything else, which is no plugin. Other fields are let be, as a newer plugin may add them. */
export function decodeAbout(body: unknown): ReadonlyArray<string> | null {
  if (typeof body !== "object" || body === null || !("features" in body)) return null;
  const { features } = body;
  return Array.isArray(features) && features.every((each) => typeof each === "string")
    ? features
    : null;
}

/**
 * Reads what the server's plugin does from its `about`, with the
 * environment's bearer, as an asset's bytes are read (`src/files/server.ts`):
 * its features, none where the server answers anything but `about`'s JSON
 * (stock T3 Code, an older Pult server, a plugin that failed to activate) or
 * cannot be reached. JSON that is not `about`'s is told; a refusal, or a
 * page that is no JSON, is not.
 */
export async function readAbout(credential: {
  readonly httpBaseUrl: string;
  readonly token: string;
}): Promise<ReadonlyArray<string>> {
  let response: Response;
  try {
    response = await fetch(new URL(ABOUT_PATH, credential.httpBaseUrl), {
      headers: { authorization: `Bearer ${credential.token}` },
    });
  } catch (error) {
    console.warn(
      `[pult-shell] could not ask the server's Pult plugin what it does: ${String(error)}`,
    );
    return [];
  }
  // A server without the route may answer its web app's page.
  if (!response.ok || response.headers.get("content-type")?.includes("application/json") !== true)
    return [];
  const features = decodeAbout(await response.json().catch(() => undefined));
  if (features === null)
    console.warn("[pult-shell] the server's Pult plugin answered no `about`: read as no plugin.");
  return features ?? [];
}
