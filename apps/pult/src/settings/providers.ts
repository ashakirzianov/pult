// The settings page's Providers (xaxis `pult/tasks/provider-setup-settings.task`): what a provider's
// row and its setup rows say and offer, and the `server.updateSettings` input a change of the
// instance writes, from what the server reports. Pure: `ProvidersSection.tsx` follows the servers
// and sends the commands. Run the test with `node --test src/settings/providers.test.ts`.
import type { EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type WS_METHODS,
} from "@t3tools/contracts";

export type UpdateSettingsInput = EnvironmentRpcInput<typeof WS_METHODS.serverUpdateSettings>;

export type RuntimeAction = "install" | "update" | "retry" | "cancel";

/** The Runtime subrow, where the server can install the provider's runtime (`setup.canInstall`). */
export interface RuntimeRow {
  readonly description: string;
  /** Bytes downloaded of the total while a download of known size runs, for the bar. */
  readonly progress: { readonly value: number; readonly max: number } | null;
  /** The server's message after a failed install. */
  readonly error: string | null;
  readonly action: RuntimeAction | null;
  /** Remove Runtime…, while the server says it can and nothing runs. */
  readonly canRemove: boolean;
}

export interface ProviderRow {
  readonly name: string;
  /** The instance's own setting, which the switch shows and writes. */
  readonly on: boolean;
  readonly status: string;
  /** No switch while the server reports the provider unavailable. */
  readonly hasSwitch: boolean;
  /** Whether its setup rows open on their own: on, with something owed. */
  readonly opensByDefault: boolean;
  readonly runtime: RuntimeRow | null;
}

const RUNNING_INSTALL = new Set<ProviderInstallState["phase"]>([
  "downloading",
  "extracting",
  "verifying",
]);

const STATUS_WORDS: Record<ServerProvider["status"], string> = {
  ready: "Ready",
  warning: "Warning",
  error: "Error",
  disabled: "Disabled",
};

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function instanceOf(
  settings: Pick<ServerSettings, "providerInstances">,
  provider: Pick<ServerProvider, "instanceId" | "driver">,
): ProviderInstanceConfig {
  return Object.hasOwn(settings.providerInstances, provider.instanceId)
    ? settings.providerInstances[provider.instanceId]!
    : { driver: provider.driver };
}

/**
 * A provider's row, from the server's report of it, its instance's settings and, while its
 * setup rows are open, its install state (undefined until the server sends one).
 */
export function providerRow(input: {
  readonly provider: ServerProvider;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly install: ProviderInstallState | undefined;
}): ProviderRow {
  const { provider, settings, install } = input;
  const config = instanceOf(settings, provider).config;
  const on = resolveProjectProviderInstanceEnabled(settings, null, provider.instanceId);
  // The server's reading (`providerInstallation.ts`): a binary path, but Codex's own name for it.
  const customRuntime =
    isRecord(config) &&
    typeof config.binaryPath === "string" &&
    config.binaryPath.trim() !== "" &&
    !(provider.driver === "codex" && config.binaryPath === "codex");
  const installing = install !== undefined && RUNNING_INSTALL.has(install.phase);
  const installed = provider.installed || (!customRuntime && install?.installedVersion != null);
  const unavailable = provider.availability === "unavailable";
  const runtime = provider.setup?.canInstall
    ? runtimeRow(install, { installing, customRuntime })
    : null;
  const status = !on
    ? "Off"
    : unavailable
      ? ["Unavailable", provider.unavailableReason].filter(Boolean).join(" · ")
      : installing
        ? "Installing"
        : !installed
          ? "Not installed"
          : provider.auth.status === "unauthenticated"
            ? "Not signed in"
            : provider.auth.status === "authenticated"
              ? provider.auth.email === undefined
                ? "Signed in"
                : `Signed in as ${provider.auth.email}`
              : [
                  STATUS_WORDS[provider.status],
                  provider.version,
                  provider.status === "error" || provider.status === "warning"
                    ? provider.message
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ");
  const owed =
    !installed ||
    provider.auth.status === "unauthenticated" ||
    installing ||
    install?.phase === "failed";
  return {
    name: provider.displayName ?? getProviderClient(provider.driver)?.label ?? provider.driver,
    on,
    status,
    hasSwitch: !unavailable,
    opensByDefault: on && runtime !== null && owed,
    runtime,
  };
}

function runtimeRow(
  install: ProviderInstallState | undefined,
  state: { readonly installing: boolean; readonly customRuntime: boolean },
): RuntimeRow {
  const { installing, customRuntime } = state;
  // The install stream's word, fresher than the provider's snapshot, which the server re-probes later.
  const installed = install?.installedVersion != null;
  const newer =
    install?.installedVersion != null &&
    install.version !== null &&
    install.version !== install.installedVersion
      ? install.version
      : null;
  const description =
    install === undefined
      ? "Checking…"
      : install.phase === "downloading"
        ? install.totalBytes === null
          ? `Downloading ${megabytes(install.downloadedBytes)} MB`
          : `Downloading ${megabytes(install.downloadedBytes)} of ${megabytes(install.totalBytes)} MB`
        : install.phase === "extracting"
          ? "Extracting"
          : install.phase === "verifying"
            ? "Checking"
            : customRuntime
              ? "Uses a custom runtime"
              : installed
                ? ["Installed", install.installedVersion, newer && `${newer} available`]
                    .filter(Boolean)
                    .join(" · ")
                : install.totalBytes === null
                  ? "Not installed"
                  : `Not installed · ${Math.ceil(install.totalBytes / 1_000_000)} MB download`;
  return {
    description,
    progress:
      install?.phase === "downloading" && install.totalBytes !== null && install.totalBytes > 0
        ? { value: install.downloadedBytes, max: install.totalBytes }
        : null,
    error: install?.phase === "failed" ? install.message : null,
    action:
      install === undefined
        ? null
        : installing
          ? install.operationId === null
            ? null
            : "cancel"
          : customRuntime
            ? null
            : install.phase === "failed" || install.phase === "cancelled"
              ? "retry"
              : newer !== null
                ? "update"
                : installed
                  ? null
                  : "install",
    // The server's `canRemove` is the managed runtime's, which it refuses to remove for a custom one.
    canRemove: install?.canRemove === true && !installing && !customRuntime,
  };
}

/** A change Pult makes to a provider instance. */
export type InstanceChange = { readonly kind: "enabled"; readonly on: boolean };

/**
 * The `server.updateSettings` input writing `change` to the provider's instance, as the server
 * last sent its settings: an upsert of the whole instance, so every secret the change leaves
 * alone goes back as the redaction marker it arrived as, which the server reads as "keep the
 * saved one". Switching on or off writes the instance's `enabled` and, where its config has one,
 * the config's too, since either being false turns it off; switching off the provider the
 * text-generation selection names resets that selection to the default, as stock does.
 */
export function instanceWrite(
  settings: Pick<
    ServerSettings,
    "providerInstances" | "projectSettingsOverrides" | "textGenerationModelSelection"
  >,
  provider: Pick<ServerProvider, "instanceId" | "driver">,
  change: InstanceChange,
): UpdateSettingsInput {
  const { instanceId } = provider;
  const current = instanceOf(settings, provider);
  const { config } = current;
  const instance: ProviderInstanceConfig = {
    ...current,
    enabled: change.on,
    ...(isRecord(config) && typeof config.enabled === "boolean"
      ? { config: { ...config, enabled: change.on } }
      : {}),
  };
  const resetsTextGeneration =
    !change.on &&
    resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
    settings.textGenerationModelSelection.instanceId === instanceId;
  return {
    patch: resetsTextGeneration
      ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
      : {},
    providerInstanceMutation: { operation: "upsert", instanceId, instance },
  };
}
