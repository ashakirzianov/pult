// Run with `node --test src/connection/pairingLink.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { getPairingTokenFromUrl } from "@t3tools/shared/remote";

import { isLoopbackHost, pairingAddresses, pairingUrl } from "./pairingLink.ts";

function endpoint(
  id: string,
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
  extra: Partial<AdvertisedEndpoint> = {},
): AdvertisedEndpoint {
  return {
    id,
    label: id,
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    reachability,
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...extra,
  };
}

NodeTest.test("a pairing link is the server's /pair page with the credential in its hash", () => {
  const url = pairingUrl("https://box.example.ts.net/base/", "abc 123");
  NodeAssert.equal(new URL(url).origin, "https://box.example.ts.net");
  NodeAssert.equal(new URL(url).pathname, "/pair");
  NodeAssert.equal(new URL(url).search, "");
  NodeAssert.equal(getPairingTokenFromUrl(new URL(url)), "abc 123");
});

NodeTest.test("loopback hosts are this machine alone", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1"])
    NodeAssert.equal(isLoopbackHost(host), true, host);
  for (const host of ["192.168.1.4", "box.tail1234.ts.net", "1270.0.0.1", "example.com"])
    NodeAssert.equal(isLoopbackHost(host), false, host);
});

NodeTest.test("an environment the page reaches over the network shares that address", () => {
  const addresses = pairingAddresses({ httpBaseUrl: "http://192.168.1.4:3773" }, "code");
  NodeAssert.deepEqual(
    addresses.map(({ id, label }) => ({ id, label })),
    [{ id: "connected", label: "192.168.1.4:3773" }],
  );
  NodeAssert.equal(new URL(addresses[0]!.url).host, "192.168.1.4:3773");
});

NodeTest.test("an environment the page reaches on loopback leaves the code alone", () => {
  NodeAssert.deepEqual(pairingAddresses({ httpBaseUrl: "http://127.0.0.1:3773" }, "code"), []);
  NodeAssert.deepEqual(pairingAddresses({ httpBaseUrl: "" }, "code"), []);
});

NodeTest.test(
  "the app's own server shares its advertised endpoints, default first, never loopback",
  () => {
    const addresses = pairingAddresses(
      {
        httpBaseUrl: "http://127.0.0.1:3773",
        endpoints: [
          endpoint("desktop-loopback:3773", "http://127.0.0.1:3773", "loopback", {
            isDefault: true,
          }),
          endpoint("desktop-lan:3773", "http://192.168.1.4:3773", "lan"),
          endpoint("tailscale-gone", "http://100.64.0.1:3773", "private-network", {
            status: "unavailable",
          }),
          endpoint("tailscale-magicdns:box", "https://box.tail1234.ts.net", "private-network", {
            isDefault: true,
          }),
        ],
      },
      "code",
    );
    NodeAssert.deepEqual(
      addresses.map((address) => address.id),
      ["tailscale-magicdns:box", "desktop-lan:3773"],
    );
    // A hosted-compatible endpoint still links to the server itself, not the hosted app.
    NodeAssert.equal(new URL(addresses[0]!.url).origin, "https://box.tail1234.ts.net");
  },
);

NodeTest.test("the app's own server with only loopback endpoints leaves the code alone", () => {
  NodeAssert.deepEqual(
    pairingAddresses(
      {
        httpBaseUrl: "http://127.0.0.1:3773",
        endpoints: [endpoint("desktop-loopback:3773", "http://127.0.0.1:3773", "loopback")],
      },
      "code",
    ),
    [],
  );
});
