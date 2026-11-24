// The settings page's Providers (xaxis `pult/tasks/provider-setup-settings.task`): what a provider's
// row and its setup rows say and offer, and the `server.updateSettings` input a change of the
// instance writes, from what the server reports. Pure: `ProvidersSection.tsx` follows the servers
// and sends the commands. Run the test with `node --test src/settings/providers.test.ts`.
import type { EnvironmentRpcInput } from "@t3tools/client-runtime/rpc";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type AntigravitySettings,
  DEFAULT_SERVER_SETTINGS,
  isSecretReference,
  isSecretSetting,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ProviderSettingsFormOption,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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

/** A field of the driver's settings under the provider: its sign-in method, or a secret. */
export interface SetupField {
  readonly key: string;
  /** The driver's own words, from its settings schema's annotations. */
  readonly label: string;
  readonly description: string | undefined;
  readonly placeholder: string | undefined;
  readonly control: "select" | "text" | "secret";
  readonly options: ReadonlyArray<ProviderSettingsFormOption>;
  /** A select's or text field's saved value; empty for a secret, whose value the page never holds. */
  readonly value: string;
  /** A secret's state: none saved, one saved (its redaction marker received), or a secret provider's reference. */
  readonly secret: "unset" | "saved" | { readonly from: string };
}

export type AccountAction = "signIn" | "connect" | "retry" | "cancel" | "changeAccount";

/** The Account subrow, where the server can sign in to the provider (`setup.canAuthenticate`). */
export interface AccountRow {
  /** A sign-in flow runs: starting, waiting on its interaction, or checking. */
  readonly active: boolean;
  readonly description: string;
  /** The server's message after a failed sign-in, or the terminal sign-in Pult cannot show. */
  readonly error: string | null;
  readonly action: AccountAction | null;
  readonly actionLabel: string;
  /** Sign In and its kin wait for the provider to be on, its runtime installed and the sign-in's state read. */
  readonly blocked: boolean;
  /** Sign Out, beside Change Account. */
  readonly canSignOut: boolean;
  /** The server's sign-in methods, where it lists several, for a select before the button. */
  readonly methods: NonNullable<ProviderAuthState["methods"]>;
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
  /** Antigravity's sign-in method and the fields it reads, else the driver's secret fields. */
  readonly fields: ReadonlyArray<SetupField>;
  readonly account: AccountRow | null;
}

/** Which of Antigravity's fields each sign-in method reads, beside its sign-in method; no annotation says. */
const ANTIGRAVITY_METHOD_FIELDS: Record<
  AntigravityAuthMethod,
  ReadonlyArray<keyof typeof AntigravitySettings.fields>
> = {
  "oauth-personal": [],
  "oauth-business": ["gcpProject", "gcpLocation"],
  "gemini-api-key": ["apiKey"],
  "agent-platform": ["apiKey", "gcpProject", "gcpLocation"],
};

/** The Antigravity sign-in methods that connect with a key or a project rather than an account. */
const CONNECTING_METHODS = new Set<AntigravityAuthMethod>(["gemini-api-key", "agent-platform"]);

const RUNNING_AUTH = new Set<ProviderAuthState["phase"]>(["starting", "waiting", "verifying"]);

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

function antigravityMethod(config: unknown): AntigravityAuthMethod {
  const value = isRecord(config) ? config.authMethod : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

function annotationsOf(schema: Schema.Top) {
  return Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
}

/** The driver's settings field, from the registry stock reads; a key it lacks is a bug of ours. */
function settingsField(driver: ServerProvider["driver"], key: string): Schema.Top {
  const field = getProviderClient(driver)?.settingsSchema.fields[key];
  if (field === undefined) throw new Error(`The ${driver} driver has no setting ${key}.`);
  return field;
}

function setupFields(provider: ServerProvider, config: unknown): ReadonlyArray<SetupField> {
  const fields = getProviderClient(provider.driver)?.settingsSchema.fields;
  if (fields === undefined || provider.setup === undefined) return [];
  const keys: ReadonlyArray<string> =
    provider.driver === "antigravity"
      ? ["authMethod", ...ANTIGRAVITY_METHOD_FIELDS[antigravityMethod(config)]]
      : Object.keys(fields).filter((key) => isSecretSetting(fields[key]!));
  return keys.map((key) => {
    const schema = settingsField(provider.driver, key);
    const annotations = annotationsOf(schema);
    const form = annotations?.providerSettingsForm;
    const saved = isRecord(config) ? config[key] : undefined;
    const control = isSecretSetting(schema)
      ? "secret"
      : form?.control === "select"
        ? "select"
        : "text";
    return {
      key,
      label: typeof annotations?.title === "string" ? annotations.title : key,
      description:
        typeof annotations?.description === "string" ? annotations.description : undefined,
      placeholder: form?.placeholder,
      control,
      options: form?.options ?? [],
      value:
        control === "secret"
          ? ""
          : key === "authMethod" && provider.driver === "antigravity"
            ? antigravityMethod(config)
            : typeof saved === "string"
              ? saved
              : (form?.options?.[0]?.value ?? ""),
      secret:
        control !== "secret"
          ? "unset"
          : isSecretReference(saved)
            ? { from: saved.provider }
            : typeof saved === "string" && saved !== ""
              ? "saved"
              : "unset",
    };
  });
}

/**
 * A provider's row, from the server's report of it, its instance's settings and, while its
 * setup rows are open, its install and sign-in states (undefined until the server sends one).
 */
export function providerRow(input: {
  readonly provider: ServerProvider;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly install: ProviderInstallState | undefined;
  readonly auth: ProviderAuthState | undefined;
  /** The environment's name, as Sign in on <environment> says it. */
  readonly environmentName: string;
}): ProviderRow {
  const { provider, settings, install, auth } = input;
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
  const signingIn = auth !== undefined && RUNNING_AUTH.has(auth.phase);
  const runtime = provider.setup?.canInstall
    ? runtimeRow(install, { installing, customRuntime })
    : null;
  const name = provider.displayName ?? getProviderClient(provider.driver)?.label ?? provider.driver;
  const account = provider.setup?.canAuthenticate
    ? accountRow({
        provider,
        auth,
        on,
        installed,
        connects:
          provider.driver === "antigravity" && CONNECTING_METHODS.has(antigravityMethod(config)),
        environmentName: input.environmentName,
      })
    : null;
  const fields = setupFields(provider, config);
  const status = !on
    ? "Off"
    : unavailable
      ? ["Unavailable", provider.unavailableReason].filter(Boolean).join(" · ")
      : installing
        ? "Installing"
        : !installed
          ? "Not installed"
          : signingIn
            ? "Signing in"
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
    signingIn ||
    install?.phase === "failed" ||
    auth?.phase === "failed";
  const hasSetup = runtime !== null || account !== null || fields.length > 0;
  return {
    name,
    on,
    status,
    hasSwitch: !unavailable,
    opensByDefault: on && hasSetup && owed,
    runtime,
    fields,
    account,
  };
}

function accountRow(input: {
  readonly provider: ServerProvider;
  readonly auth: ProviderAuthState | undefined;
  readonly on: boolean;
  readonly installed: boolean;
  /** Antigravity with a key or a project: Connect, not Sign In. */
  readonly connects: boolean;
  readonly environmentName: string;
}): AccountRow {
  const { provider, auth, on, installed, connects, environmentName } = input;
  const active = auth !== undefined && RUNNING_AUTH.has(auth.phase);
  const interaction = auth?.interaction ?? null;
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const terminal = active && interaction?.type === "terminal";
  const failed = auth?.phase === "failed" || auth?.phase === "cancelled";
  const description = active
    ? auth.phase === "starting"
      ? (auth.message ?? (connects ? "Connecting…" : "Starting sign-in…"))
      : auth.phase === "verifying"
        ? connects
          ? "Checking credentials…"
          : "Checking your account…"
        : interaction?.type === "credentials"
          ? "Enter your credentials below."
          : interaction?.type === "deviceCode"
            ? "Enter the code below in your browser."
            : terminal
              ? ""
              : "Finish signing in in your browser."
    : signedIn
      ? provider.auth.email === undefined
        ? "Signed in"
        : `Signed in as ${provider.auth.email}`
      : !on
        ? "Sign in once the provider is on."
        : !installed
          ? "Sign in once the runtime is installed."
          : connects
            ? `Connect on ${environmentName} to load models.`
            : `Sign in on ${environmentName}.`;
  const action: AccountAction | null = active
    ? auth.flowId === null
      ? null
      : "cancel"
    : signedIn
      ? "changeAccount"
      : failed
        ? "retry"
        : connects
          ? "connect"
          : "signIn";
  return {
    active,
    description,
    error: terminal
      ? "This sign-in needs a terminal, which Pult does not have yet; sign in from T3 Code."
      : auth?.phase === "failed"
        ? auth.message
        : null,
    action,
    actionLabel:
      action === null
        ? ""
        : {
            signIn: "Sign In",
            connect: "Connect",
            retry: connects ? "Retry Connection" : "Retry",
            cancel: "Cancel",
            changeAccount: "Change Account",
          }[action],
    blocked: action !== "cancel" && (!on || !installed || auth === undefined),
    canSignOut:
      !active &&
      signedIn &&
      (provider.auth.canLogout ?? provider.setup?.canAuthenticate ?? false) &&
      auth !== undefined,
    methods: !active && (auth?.methods?.length ?? 0) > 1 ? (auth?.methods ?? []) : [],
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

/** A change Pult makes to a provider instance: its switch, or one field of its config, a secret's empty value clearing it. */
export type InstanceChange =
  | { readonly kind: "enabled"; readonly on: boolean }
  | { readonly kind: "field"; readonly key: string; readonly value: string };

/**
 * The `server.updateSettings` input writing `change` to the provider's instance, as the server
 * last sent its settings: an upsert of the whole instance, so every secret the change leaves
 * alone goes back as the redaction marker it arrived as, which the server reads as "keep the
 * saved one". Switching on or off writes the instance's `enabled` and, where its config has one,
 * the config's too, since either being false turns it off; switching off the provider the
 * text-generation selection names resets that selection to the default, as stock does. A field
 * writes its value into the config, an empty secret clearing the saved one and an empty plain
 * field leaving the config where its annotation says to omit it.
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
  if (change.kind === "field") {
    const schema = settingsField(provider.driver, change.key);
    const next: Record<string, unknown> = isRecord(config) ? { ...config } : {};
    if (
      !isSecretSetting(schema) &&
      change.value.trim() === "" &&
      annotationsOf(schema)?.providerSettingsForm?.clearWhenEmpty === "omit"
    ) {
      delete next[change.key];
    } else {
      next[change.key] = change.value;
    }
    return {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId,
        instance: { ...current, config: next },
      },
    };
  }
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
