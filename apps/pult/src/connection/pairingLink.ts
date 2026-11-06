// Where a pairing link Pair Device mints points (xaxis `pult/issues/pair-device`),
// apart from the workbench so `node --test src/connection/pairingLink.test.ts`
// can run it. Never upstream's hosted pairing link (`pult/decisions`,
// `t3-connect-stance`).
import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

/** An address of the environment's server another device may open a pairing link on, with the link. */
export interface PairingAddress {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

/** The server's `/pair` page with the credential in its hash, as upstream's `resolveDesktopPairingUrl` builds it. */
export function pairingUrl(httpBaseUrl: string, credential: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

/** Whether a host names this machine alone, which a scanning device would take for itself. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  );
}

/**
 * The addresses a pairing link may use, the first the one to show: for
 * Pult.app's own server, the endpoints the app advertises (`endpoints`), the
 * available ones that are not loopback, its default first, as upstream's
 * `selectPairingEndpoint` prefers it; for any other environment, the address
 * the page connects to, unless it is loopback. None leaves the code alone.
 */
export function pairingAddresses(
  input: {
    readonly httpBaseUrl: string;
    readonly endpoints?: ReadonlyArray<AdvertisedEndpoint>;
  },
  credential: string,
): ReadonlyArray<PairingAddress> {
  if (input.endpoints !== undefined) {
    const shareable = input.endpoints.filter(
      (endpoint) => endpoint.status !== "unavailable" && endpoint.reachability !== "loopback",
    );
    return [
      ...shareable.filter((endpoint) => endpoint.isDefault === true),
      ...shareable.filter((endpoint) => endpoint.isDefault !== true),
    ].map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      url: pairingUrl(endpoint.httpBaseUrl, credential),
    }));
  }
  if (!URL.canParse(input.httpBaseUrl)) return [];
  const url = new URL(input.httpBaseUrl);
  if (isLoopbackHost(url.hostname)) return [];
  return [{ id: "connected", label: url.host, url: pairingUrl(input.httpBaseUrl, credential) }];
}
