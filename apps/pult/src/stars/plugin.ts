// The server's Pult plugin, as the page asks it (`plugins/pult`, xaxis
// `pult/design-durable-agent-sleep`): the one file that names its routes,
// apart from the workbench so `node --test src/stars/plugin.test.ts` can run
// it. Today only `about`, which says what the plugin of a server does.

/** The plugin's feature of keeping the Stars: where `about` lists it, the server puts a Star's conversations to sleep and writes their transcripts, and the page does neither. */
export const STARS_FEATURE = "stars";

const ABOUT_PATH = "/api/plugins/pult/about";

/** How long `about` may take before the server reads as having no plugin: the page's keeper waits on it. */
const ABOUT_TIMEOUT_MS = 10_000;

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
 * cannot be reached within `ABOUT_TIMEOUT_MS`. JSON that is not `about`'s,
 * and a refusal other than 404, are told; a 404, or a page that is no JSON,
 * is not.
 */
export async function readAbout(credential: {
  readonly httpBaseUrl: string;
  readonly token: string;
}): Promise<ReadonlyArray<string>> {
  let response: Response;
  try {
    response = await fetch(new URL(ABOUT_PATH, credential.httpBaseUrl), {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(ABOUT_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `[pult-shell] could not ask the server's Pult plugin what it does: ${String(error)}`,
    );
    return [];
  }
  // A server without the route answers 404, or its web app's page. Any other
  // refusal may be a server whose plugin keeps its Stars, which the page then
  // keeps too: told, not silent.
  if (!response.ok) {
    if (response.status !== 404)
      console.warn(
        `[pult-shell] the server's Pult plugin refused \`about\` (${response.status}): read as no plugin.`,
      );
    return [];
  }
  if (response.headers.get("content-type")?.includes("application/json") !== true) return [];
  const features = decodeAbout(await response.json().catch(() => undefined));
  if (features === null)
    console.warn("[pult-shell] the server's Pult plugin answered no `about`: read as no plugin.");
  return features ?? [];
}
