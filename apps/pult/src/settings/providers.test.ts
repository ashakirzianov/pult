// Run with `node --test src/settings/providers.test.ts`.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { instanceWrite, providerRow } from "./providers.ts";

const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
/** The server's redaction marker for a saved secret, `SECRET_REDACTED` in `apps/server/src/settingsSecrets.ts`. */
const SAVED = "\u2022\u2022\u2022\u2022\u2022\u2022";
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

function auth(overrides: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId: ANTIGRAVITY,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
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
      auth: undefined,
      environmentName: "MacBook",
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
        auth: undefined,
        environmentName: "MacBook",
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
      auth: undefined,
      environmentName: "MacBook",
    });
    NodeAssert.equal(row.runtime?.description, "Installed · 1.4.2 · 1.5.0 available");
    NodeAssert.equal(row.runtime?.action, "update");
    NodeAssert.equal(row.runtime?.canRemove, true);

    // The managed runtime the server can remove is not a custom-runtime instance's.
    const custom = providerRow({
      provider: provider(),
      settings: settings({ enabled: true, config: { binaryPath: "/opt/agy" } }),
      install: install({ installedVersion: "1.4.2" }),
      auth: undefined,
      environmentName: "MacBook",
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
      auth: undefined,
      environmentName: "MacBook",
    });
    NodeAssert.equal(row.status, "Installing");
    NodeAssert.equal(row.runtime?.description, "Downloading 34.1 of 81.0 MB");
    NodeAssert.deepEqual(row.runtime?.progress, { value: 34_100_000, max: 81_000_000 });
    NodeAssert.equal(row.runtime?.action, "cancel");
    NodeAssert.equal(row.runtime?.canRemove, false);
  });

  NodeTest.it("reads Not signed in with Sign In, or Connect for a Gemini API key", () => {
    const signIn = providerRow({
      provider: provider(),
      settings: settings(),
      install: install(),
      auth: auth(),
      environmentName: "MacBook",
    });
    NodeAssert.equal(signIn.status, "Not signed in");
    NodeAssert.equal(signIn.opensByDefault, true);
    NodeAssert.equal(signIn.account?.description, "Sign in on MacBook.");
    NodeAssert.equal(signIn.account?.actionLabel, "Sign In");
    NodeAssert.equal(signIn.account?.blocked, false);
    NodeAssert.deepEqual(
      signIn.fields.map((field) => field.key),
      ["authMethod"],
    );

    const connect = providerRow({
      provider: provider(),
      settings: settings({
        enabled: true,
        config: { authMethod: "gemini-api-key", apiKey: SAVED },
      }),
      install: install(),
      auth: auth(),
      environmentName: "MacBook",
    });
    NodeAssert.equal(connect.account?.action, "connect");
    NodeAssert.equal(connect.account?.actionLabel, "Connect");
    NodeAssert.equal(connect.account?.description, "Connect on MacBook to load models.");
    NodeAssert.deepEqual(
      connect.fields.map((field) => [field.key, field.control, field.secret]),
      [
        ["authMethod", "select", "unset"],
        ["apiKey", "secret", "saved"],
      ],
    );
  });

  NodeTest.it("reads Signed in as the email, with its rows closed", () => {
    const row = providerRow({
      provider: provider({ auth: { status: "authenticated", email: "anton@example.com" } }),
      settings: settings(),
      install: undefined,
      auth: undefined,
      environmentName: "MacBook",
    });
    NodeAssert.equal(row.status, "Signed in as anton@example.com");
    NodeAssert.equal(row.opensByDefault, false);
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

  NodeTest.it("keeps the saved API key's redaction marker when the GCP project changes", () => {
    const write = instanceWrite(
      settings({
        enabled: true,
        config: { authMethod: "agent-platform", apiKey: SAVED, gcpLocation: "us-central1" },
      }),
      provider(),
      { kind: "field", key: "gcpProject", value: "my-project" },
    );
    NodeAssert.deepEqual(write, {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: ANTIGRAVITY,
        instance: {
          driver: DRIVER,
          enabled: true,
          config: {
            authMethod: "agent-platform",
            apiKey: SAVED,
            gcpLocation: "us-central1",
            gcpProject: "my-project",
          },
        },
      },
    });
  });

  NodeTest.it("writes an empty value to clear a secret", () => {
    const write = instanceWrite(
      settings({ enabled: true, config: { authMethod: "gemini-api-key", apiKey: SAVED } }),
      provider(),
      { kind: "field", key: "apiKey", value: "" },
    );
    const mutation = write.providerInstanceMutation;
    NodeAssert.equal(mutation?.operation, "upsert");
    NodeAssert.deepEqual(mutation?.operation === "upsert" ? mutation.instance.config : null, {
      authMethod: "gemini-api-key",
      apiKey: "",
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
