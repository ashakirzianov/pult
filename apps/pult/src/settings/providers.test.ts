// Run with `node --test src/settings/providers.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { instanceWrite, providerRow } from "./providers.ts";

const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const DRIVER = ProviderDriverKind.make("antigravity");

/** Antigravity as the server reports it: on, set up to install and sign in, its runtime installed, signed out. */
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ANTIGRAVITY,
    driver: DRIVER,
    setup: { canAuthenticate: true, canInstall: true },
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: "ready",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-11-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function settings(
  instance: Omit<ProviderInstanceConfig, "driver"> = { enabled: true },
  overrides: Partial<ServerSettings> = {},
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [ANTIGRAVITY]: { driver: DRIVER, ...instance } },
    ...overrides,
  };
}

function install(overrides: Partial<ProviderInstallState> = {}): ProviderInstallState {
  return {
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: 81_000_000,
    version: "1.5.0",
    installedVersion: "1.5.0",
    canRemove: true,
    message: null,
    ...overrides,
  };
}

NodeTest.describe("providerRow", () => {
  NodeTest.it("reads Off with its rows closed while the instance is off", () => {
    const row = providerRow({
      provider: provider({ enabled: false, installed: false }),
      settings: settings({ enabled: false }),
      install: undefined,
    });
    NodeAssert.equal(row.on, false);
    NodeAssert.equal(row.status, "Off");
    NodeAssert.equal(row.opensByDefault, false);
  });

  NodeTest.it(
    "reads Not installed with its rows open and Install while nothing is installed",
    () => {
      const row = providerRow({
        provider: provider({ installed: false }),
        settings: settings(),
        install: install({ installedVersion: null, canRemove: false }),
      });
      NodeAssert.equal(row.status, "Not installed");
      NodeAssert.equal(row.opensByDefault, true);
      NodeAssert.equal(row.runtime?.description, "Not installed · 81 MB download");
      NodeAssert.equal(row.runtime?.action, "install");
    },
  );

  NodeTest.it("offers Update while the server has a newer version than the installed one", () => {
    const row = providerRow({
      provider: provider(),
      settings: settings(),
      install: install({ installedVersion: "1.4.2" }),
    });
    NodeAssert.equal(row.runtime?.description, "Installed · 1.4.2 · 1.5.0 available");
    NodeAssert.equal(row.runtime?.action, "update");
    NodeAssert.equal(row.runtime?.canRemove, true);

    // The managed runtime the server can remove is not a custom-runtime instance's.
    const custom = providerRow({
      provider: provider(),
      settings: settings({ enabled: true, config: { binaryPath: "/opt/agy" } }),
      install: install({ installedVersion: "1.4.2" }),
    });
    NodeAssert.equal(custom.runtime?.description, "Uses a custom runtime");
    NodeAssert.equal(custom.runtime?.action, null);
    NodeAssert.equal(custom.runtime?.canRemove, false);
  });

  NodeTest.it("offers Cancel with its bytes while a download runs", () => {
    const row = providerRow({
      provider: provider({ installed: false }),
      settings: settings(),
      install: install({
        phase: "downloading",
        operationId: "op-1",
        downloadedBytes: 34_100_000,
        installedVersion: null,
      }),
    });
    NodeAssert.equal(row.status, "Installing");
    NodeAssert.equal(row.runtime?.description, "Downloading 34.1 of 81.0 MB");
    NodeAssert.deepEqual(row.runtime?.progress, { value: 34_100_000, max: 81_000_000 });
    NodeAssert.equal(row.runtime?.action, "cancel");
    NodeAssert.equal(row.runtime?.canRemove, false);
  });
});

NodeTest.describe("instanceWrite", () => {
  NodeTest.it("writes both flags when enabling", () => {
    const write = instanceWrite(
      settings({ enabled: false, config: { enabled: false, authMethod: "oauth-personal" } }),
      provider(),
      { kind: "enabled", on: true },
    );
    NodeAssert.deepEqual(write, {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: ANTIGRAVITY,
        instance: {
          driver: DRIVER,
          enabled: true,
          config: { enabled: true, authMethod: "oauth-personal" },
        },
      },
    });
  });

  NodeTest.it("resets the text-generation selection when disabling the provider it names", () => {
    const write = instanceWrite(
      settings(
        { enabled: true },
        { textGenerationModelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-flash" } },
      ),
      provider(),
      { kind: "enabled", on: false },
    );
    NodeAssert.deepEqual(write.patch, {
      textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    });
    NodeAssert.equal(write.providerInstanceMutation?.operation, "upsert");
  });
});
