// What a browser tab's citation names as its source (`src/composer/cite.ts`,
// `pult/decisions`, `browser-cite-source`): the project file behind a page the
// environment serves from a checkout, else the page's URL. Pure, so
// `node --test src/preview/citeSource.test.ts` runs it.
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

import { joinPath } from "../files/paths.ts";

/** The server's asset route (`apps/server/src/assets/AssetAccess.ts`): `/api/assets/<payload>.<signature>/<path>`. */
const ASSET_ROUTE = "/api/assets/";

export type CiteSource =
  | { readonly kind: "file"; readonly hostPath: string }
  | { readonly kind: "url"; readonly url: string };

/**
 * The source of a selection in a browser tab whose session's server knows it
 * at `url`, on an environment answering at `httpBaseUrl`: on the
 * environment's asset route (its origin, or loopback, as
 * `previewPdfAssetUrl` checks), the file the payload's claims name, a
 * `workspace-file`'s under its base for a page reached by a link from the
 * opened one, a `workspace-file-exact`'s itself; any other page, or claims
 * of another kind, the URL. Claims that fail to decode warn in the console
 * and cite the URL, so a change to the token's format shows up there.
 */
export function citeSource(url: string, httpBaseUrl: string | undefined): CiteSource {
  const byUrl = { kind: "url", url } as const;
  if (!URL.canParse(url)) return byUrl;
  const page = new URL(url);
  const environmentOrigin =
    httpBaseUrl !== undefined && URL.canParse(httpBaseUrl)
      ? new URL(httpBaseUrl).origin
      : undefined;
  if (
    !page.pathname.startsWith(ASSET_ROUTE) ||
    (page.origin !== environmentOrigin &&
      !isLocalLoopbackHost(page.hostname) &&
      page.hostname !== "0.0.0.0")
  )
    return byUrl;
  const suffix = page.pathname.slice(ASSET_ROUTE.length);
  const slash = suffix.indexOf("/");
  const claims = slash > 0 ? decodeClaims(suffix.slice(0, slash).split(".")[0] ?? "") : undefined;
  const requested = slash > 0 ? decodedPath(suffix.slice(slash + 1)) : undefined;
  if (claims === undefined || requested === undefined) {
    console.warn("[pult-shell] Cite could not read the asset URL's claims; it cites the URL.", url);
    return byUrl;
  }
  switch (claims.kind) {
    case "workspace-file":
      if (typeof claims.workspaceRoot === "string" && typeof claims.baseRelativePath === "string")
        return {
          kind: "file",
          hostPath: joinPath(
            claims.workspaceRoot,
            claims.baseRelativePath === "."
              ? requested
              : joinPath(claims.baseRelativePath, requested),
          ),
        };
      break;
    case "workspace-file-exact":
      if (typeof claims.workspaceRoot === "string" && typeof claims.relativePath === "string")
        return { kind: "file", hostPath: joinPath(claims.workspaceRoot, claims.relativePath) };
      break;
    default:
      return byUrl;
  }
  console.warn("[pult-shell] Cite could not read the asset URL's claims; it cites the URL.", url);
  return byUrl;
}

/** The payload's claims, base64url JSON of version 1, as the server signs them; undefined when they do not decode. */
function decodeClaims(payload: string): Record<string, unknown> | undefined {
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof claims === "object" &&
      claims !== null &&
      "version" in claims &&
      claims.version === 1 &&
      "kind" in claims &&
      typeof claims.kind === "string"
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function decodedPath(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
