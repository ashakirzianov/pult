// Pult: a brand whose renderer hosts VS Code's webviews (`rendererHostsWebviews`).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { handleMock, registerSchemesAsPrivilegedMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  registerSchemesAsPrivilegedMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
  protocol: {
    handle: handleMock,
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: registerSchemesAsPrivilegedMock,
  },
}));

vi.mock("../app/DesktopBrand.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/DesktopBrand.ts")>();
  return {
    ...original,
    desktopBrand: { ...original.T3CODE_DESKTOP_BRAND, rendererHostsWebviews: true },
  };
});

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol, a renderer hosting webviews", () => {
  it.effect("lets its schemes register service workers and its page load webview resources", () =>
    Effect.gen(function* () {
      yield* Layer.build(ElectronProtocol.layerSchemePrivileges);
      const schemes = registerSchemesAsPrivilegedMock.mock.calls[0]![0] as ReadonlyArray<{
        readonly privileges: { readonly allowServiceWorkers?: boolean };
      }>;
      assert.deepEqual(
        schemes.map((scheme) => scheme.privileges.allowServiceWorkers),
        [true, true],
      );

      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({
        scheme: "t3code",
        assetDirectory: directory,
        clerkFrontendApiHostname: undefined,
      });
      const page = yield* Effect.promise(() => handler!(new Request("t3code://app/")));
      const policy = page.headers.get("content-security-policy") ?? "";
      assert.include(
        policy,
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://*.vscode-resource.vscode-cdn.net;",
      );
      assert.include(
        policy,
        "style-src 'self' 'unsafe-inline' https://*.vscode-resource.vscode-cdn.net;",
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
  );
});
