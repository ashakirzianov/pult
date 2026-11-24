import {
  getService,
  IClipboardService,
  IDialogService,
  INotificationService,
  IOpenerService,
} from "@codingame/monaco-vscode-api";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
  requestGuarded,
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the page runs none of upstream's atoms the client guard reads; the server checks the scopes itself.
  RpcPermissionGuard,
  subscribe,
} from "@t3tools/client-runtime/rpc";
import {
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerConfig,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type ComponentProps, useEffect, useState, useSyncExternalStore } from "react";

import {
  hasUsageProviderIcon,
  UsageProviderIcon,
  usageProvider,
} from "../../view/usageProviders.tsx";
import { connection, environmentName, type ShellEnvironment } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import {
  type AccountRow,
  instanceWrite,
  type InstanceChange,
  providerRow,
  type RuntimeRow,
  type SetupField,
} from "./providers.ts";

/** The client's guard reads the session's scopes through upstream's atoms, which the page does not run; the server checks them itself. */
const serverChecks = { authorize: () => Effect.void };

/** Sends one of upstream's RPCs on the environment, as `src/limits/model.ts` sends its refresh. */
function send<Tag extends EnvironmentUnaryRpcTag>(
  environmentId: string,
  tag: Tag,
  input: EnvironmentRpcInput<Tag>,
) {
  return connection.run(
    environmentId,
    requestGuarded(tag, input).pipe(Effect.provideService(RpcPermissionGuard, serverChecks)),
  );
}

/** What a failed command shows under its row: the server's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a failed command that carried typed secrets shows: the server's message, unless it quotes
 * one of them, which then never reaches the page's text.
 */
function messageWithout(error: unknown, typed: ReadonlyArray<string>, instead: string): string {
  const message = messageOf(error);
  return typed.some((value) => value !== "" && message.includes(value)) ? instead : message;
}

async function copy(text: string, what: string): Promise<void> {
  await (await getService(IClipboardService)).writeText(text);
  (await getService(INotificationService)).info(`Copied the ${what}.`);
}

/** A setup stream's state as it last stood, or why it cannot be read (a session without `providers:manage`, say). */
type Followed<A> =
  | { readonly _tag: "state"; readonly state: A }
  | { readonly _tag: "failed"; readonly message: string };

function followSetup<A>(
  environmentId: string,
  stream: Stream.Stream<A, unknown, EnvironmentSupervisor.EnvironmentSupervisor>,
  onState: (state: Followed<A>) => void,
): () => void {
  return connection.follow(
    environmentId,
    stream.pipe(
      Stream.map((state): Followed<A> => ({ _tag: "state", state })),
      Stream.catchCause((cause) =>
        Stream.succeed<Followed<A>>({ _tag: "failed", message: messageOf(Cause.squash(cause)) }),
      ),
    ),
    onState,
  );
}

/** Which providers' setup rows the user opened or closed, by environment and instance, for the page's session. */
const chosenOpen = new Map<string, boolean>();

/**
 * Each provider's writes, by environment and instance, one after another, each built on the
 * server's settings as `server.getSettings` reads them at its turn, never on the config stream's:
 * the stream can trail a write's answer, or replay an older copy when it restarts, and a write
 * built on such a copy would upsert the instance without what was saved since, a secret among it,
 * which the server drops when a write leaves it out.
 */
const instanceWrites = new Map<string, Promise<unknown>>();

function writeInstance(
  environmentId: string,
  key: string,
  provider: ServerProvider,
  change: InstanceChange,
): Promise<void> {
  const sent = (instanceWrites.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const current = await send(environmentId, WS_METHODS.serverGetSettings, {});
      await send(
        environmentId,
        WS_METHODS.serverUpdateSettings,
        instanceWrite(current, provider, change),
      );
    });
  instanceWrites.set(key, sent);
  return sent;
}

/**
 * Providers: per held environment, in the Environments section's order, every provider its
 * server reports, in the server's order, each on or off by a switch, and under one with setup,
 * its runtime (xaxis `pult/tasks/provider-setup-settings.task`). Everything goes through
 * upstream's RPCs on that environment's connection; the server owns every state shown.
 */
export function ProvidersSection() {
  const environments = useSyncExternalStore(
    (listener) => connection.onDidChange(listener),
    () => connection.environments,
  );
  if (environments.length === 0) return null;
  const local = connection.localEnvironment;
  const ordered =
    local === undefined
      ? environments
      : [
          local,
          ...environments.filter(
            (environment) => environment.environmentId !== local.environmentId,
          ),
        ];
  return (
    <section className="pult-settings-section">
      <h2>Providers</h2>
      {ordered.map((environment) => (
        <ProvidersGroup
          key={environment.environmentId}
          environment={environment}
          name={environmentName(environment, environments)}
          headed={ordered.length > 1}
        />
      ))}
    </section>
  );
}

/**
 * An environment's providers, a group, headed by the environment's name while the page holds
 * several. Its config as the server last sent it, so an environment not ready keeps its rows,
 * greyed with no controls, as does one whose config is still the page's cached copy, whose rows
 * may show a state the server has left; one never read shows nothing.
 */
function ProvidersGroup({
  environment,
  name,
  headed,
}: {
  environment: ShellEnvironment;
  name: string;
  headed: boolean;
}) {
  const { environmentId } = environment;
  // Keyed by the environment, so another environment's config never shows here.
  const [followed, setFollowed] = useState<{
    readonly environmentId: string;
    readonly config: ServerConfig;
    readonly live: boolean;
  }>();
  useEffect(
    () =>
      followServerConfig(environmentId, (config, live) =>
        setFollowed({ environmentId, config, live }),
      ),
    [environmentId],
  );
  if (followed?.environmentId !== environmentId) return null;
  const { config, live } = followed;
  const writable = live && environment.phase === "ready";
  return (
    <div className="pult-settings-group pult-settings-providers" data-stale={!writable}>
      {headed ? (
        <div className="pult-settings-row pult-settings-group-head">
          <h3 className="pult-settings-row-text">{name}</h3>
        </div>
      ) : null}
      {config.providers.map((provider) => (
        <ProviderRows
          key={provider.instanceId}
          environmentId={environmentId}
          environmentName={name}
          provider={provider}
          config={config}
          writable={writable}
        />
      ))}
    </div>
  );
}

/**
 * A provider's row and, under its chevron, its setup rows: open on their own while the provider
 * is on and something is owed, and then until the user closes them, else as the user left them. While they are open its install and
 * sign-in states are followed, and stop with them.
 */
function ProviderRows({
  environmentId,
  environmentName,
  provider,
  config,
  writable,
}: {
  environmentId: string;
  environmentName: string;
  provider: ServerProvider;
  config: ServerConfig;
  writable: boolean;
}) {
  const { instanceId } = provider;
  const key = `${environmentId}:${instanceId}`;
  const [chosen, setChosen] = useState(() => chosenOpen.get(key));
  const [install, setInstall] = useState<Followed<ProviderInstallState>>();
  const [auth, setAuth] = useState<Followed<ProviderAuthState>>();
  const [error, setError] = useState<string | null>(null);
  const installState = install?._tag === "state" ? install.state : undefined;
  const authState = auth?._tag === "state" ? auth.state : undefined;
  const row = providerRow({
    provider,
    settings: config.settings,
    install: installState,
    auth: authState,
    environmentName,
  });
  const hasSetup = row.runtime !== null || row.account !== null || row.fields.length > 0;
  const open = writable && hasSetup && (chosen ?? row.opensByDefault);
  // Rows that opened on their own stay open once what was owed is done, as if the user opened them.
  if (open && chosen === undefined) {
    chosenOpen.set(key, true);
    setChosen(true);
  }
  const followsInstall = open && provider.setup?.canInstall === true;
  const followsAuth = open && provider.setup?.canAuthenticate === true;
  useEffect(() => {
    if (!followsInstall) return;
    const stop = followSetup(
      environmentId,
      subscribe(WS_METHODS.providerInstallSubscribe, { instanceId }),
      setInstall,
    );
    return () => {
      stop();
      setInstall(undefined);
    };
  }, [environmentId, instanceId, followsInstall]);
  useEffect(() => {
    if (!followsAuth) return;
    const stop = followSetup(
      environmentId,
      subscribe(WS_METHODS.providerAuthSubscribe, { instanceId }),
      setAuth,
    );
    return () => {
      stop();
      setAuth(undefined);
    };
  }, [environmentId, instanceId, followsAuth]);

  const toggle = () => {
    chosenOpen.set(key, !open);
    setChosen(!open);
  };
  const write = (change: InstanceChange) => writeInstance(environmentId, key, provider, change);
  // The value the user last asked the switch for, held over the config stream, which lags the
  // write, until its write is answered and a config the stream sent since the click agrees (the
  // one shown at the click may agree only by being stale); a failed write lets it go.
  const [asked, setAsked] = useState<{
    readonly on: boolean;
    readonly since: ServerConfig;
    readonly written: boolean;
  }>();
  if (asked?.written === true && config !== asked.since && asked.on === row.on) {
    setAsked(undefined);
  }
  const on = asked?.on ?? row.on;
  const switchTo = (value: boolean) => {
    const ask = { on: value, since: config, written: false };
    setAsked(ask);
    setError(null);
    write({ kind: "enabled", on: value }).then(
      () => setAsked((held) => (held === ask ? { ...ask, written: true } : held)),
      (failure: unknown) => {
        setError(messageOf(failure));
        setAsked((held) => (held === ask ? undefined : held));
      },
    );
  };

  return (
    <>
      <div className="pult-settings-row pult-settings-provider" data-off={!row.on}>
        <ProviderIcon driver={provider.driver} />
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">{row.name}</div>
          <div className="pult-settings-row-description">{row.status}</div>
          {error === null ? null : <div className="pult-settings-row-error">{error}</div>}
        </div>
        {writable ? (
          <div className="pult-settings-row-actions">
            {hasSetup ? (
              <button
                type="button"
                className="pult-settings-icon-button pult-settings-chevron"
                aria-expanded={open}
                aria-label={open ? "Hide Setup" : "Show Setup"}
                title={open ? "Hide Setup" : "Show Setup"}
                onClick={toggle}
              >
                <i className="codicon codicon-chevron-down" aria-hidden />
              </button>
            ) : null}
            {row.hasSwitch ? (
              <button
                type="button"
                role="switch"
                className="pult-settings-switch"
                aria-checked={on}
                aria-label={row.name}
                onClick={() => switchTo(!on)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {open && row.runtime !== null ? (
        <RuntimeSubrow
          environmentId={environmentId}
          environmentName={environmentName}
          instanceId={instanceId}
          runtime={row.runtime}
          operationId={installState?.operationId ?? null}
          failure={install?._tag === "failed" ? install.message : null}
        />
      ) : null}
      {open
        ? row.fields.map((field) => (
            <FieldSubrow
              key={field.key}
              field={field}
              write={(value) => write({ kind: "field", key: field.key, value })}
            />
          ))
        : null}
      {open && row.account !== null ? (
        <AccountSubrows
          environmentId={environmentId}
          environmentName={environmentName}
          provider={provider}
          name={row.name}
          account={row.account}
          auth={authState}
          failure={auth?._tag === "failed" ? auth.message : null}
        />
      ) : null}
    </>
  );
}

/** A provider's icon, the Limits shelf's (`view/usageProviders.tsx`), else its colour as a dot. */
function ProviderIcon({ driver }: { driver: ServerProvider["driver"] }) {
  return (
    <span className="pult-settings-provider-icon" aria-hidden>
      {hasUsageProviderIcon(driver) ? (
        <UsageProviderIcon driver={driver} />
      ) : (
        <span
          className="pult-settings-provider-dot"
          style={{ "--pult-provider-color": usageProvider(driver)?.color } as React.CSSProperties}
        />
      )}
    </span>
  );
}

const RUNTIME_LABELS = {
  install: "Install",
  update: "Update",
  retry: "Retry",
  cancel: "Cancel",
} as const;

/**
 * The Runtime subrow: what the server says of the provider's runtime, the download's bar while
 * bytes arrive, its one action, and Remove Runtime… after the workbench's dialog.
 */
function RuntimeSubrow({
  environmentId,
  environmentName,
  instanceId,
  runtime,
  operationId,
  failure,
}: {
  environmentId: string;
  environmentName: string;
  instanceId: ServerProvider["instanceId"];
  runtime: RuntimeRow;
  operationId: string | null;
  failure: string | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (command: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    command()
      .catch((failed: unknown) => setError(messageOf(failed)))
      .finally(() => setPending(false));
  };
  const act = (action: NonNullable<RuntimeRow["action"]>) =>
    run(() =>
      action === "cancel"
        ? operationId === null
          ? Promise.resolve()
          : send(environmentId, WS_METHODS.providerInstallCancel, { instanceId, operationId })
        : send(environmentId, WS_METHODS.providerInstallStart, { instanceId }),
    );
  const remove = async () => {
    const { confirmed } = await (
      await getService(IDialogService)
    ).confirm({
      message: `Remove the downloaded runtime from ${environmentName}?`,
      detail: "Sign-in and thread history are kept.",
      primaryButton: "Remove Runtime",
    });
    if (confirmed) run(() => send(environmentId, WS_METHODS.providerInstallRemove, { instanceId }));
  };
  const shownError = error ?? failure ?? runtime.error;
  const { action } = runtime;
  return (
    <div className="pult-settings-row pult-settings-subrow pult-settings-setup-row">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">Runtime</div>
        <div className="pult-settings-row-description">{runtime.description}</div>
        {runtime.progress === null ? null : (
          <progress
            className="pult-settings-progress"
            aria-label="Download"
            value={runtime.progress.value}
            max={runtime.progress.max}
          />
        )}
        {shownError === null ? null : <div className="pult-settings-row-error">{shownError}</div>}
      </div>
      {action === null && !runtime.canRemove ? null : (
        <div className="pult-settings-row-actions">
          {action === null ? null : (
            <button
              type="button"
              className="pult-settings-button"
              disabled={pending}
              onClick={() => act(action)}
            >
              {RUNTIME_LABELS[action]}
            </button>
          )}
          {runtime.canRemove ? (
            <button
              type="button"
              className="pult-settings-icon-button"
              title="Remove Runtime…"
              aria-label="Remove Runtime…"
              disabled={pending}
              onClick={() => void remove()}
            >
              <i className="codicon codicon-trash" aria-hidden />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One of the driver's fields: the sign-in method a select, writing as it changes; a text field
 * committing on Enter or blur; a secret its own input (`SecretInput`). A failed write shows the
 * server's message under it.
 */
function FieldSubrow({
  field,
  write,
}: {
  field: SetupField;
  write: (value: string) => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const commit = (value: string) => {
    setError(null);
    write(value).catch((failure: unknown) => setError(messageOf(failure)));
  };
  return (
    <div className="pult-settings-row pult-settings-subrow pult-settings-setup-row">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">{field.label}</div>
        {field.description === undefined ? null : (
          <div className="pult-settings-row-description">{field.description}</div>
        )}
        {error === null ? null : <div className="pult-settings-row-error">{error}</div>}
      </div>
      <div className="pult-settings-row-actions">
        {field.control === "select" ? (
          <Select
            aria-label={field.label}
            value={field.value}
            onChange={(event) => commit(event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : field.control === "text" ? (
          <TextInput field={field} commit={commit} />
        ) : (
          <SecretInput field={field} write={write} setError={setError} />
        )}
      </div>
    </div>
  );
}

/** A select in the page's neutral control, its arrow drawn, its list the platform's. */
function Select(props: ComponentProps<"select">) {
  return (
    <span className="pult-settings-select">
      <select {...props} />
      <i className="codicon codicon-chevron-down" aria-hidden />
    </span>
  );
}

/** A plain field: its saved value until edited, written on Enter or blur when it changed. */
function TextInput({ field, commit }: { field: SetupField; commit: (value: string) => void }) {
  const [draft, setDraft] = useState<string>();
  const value = draft ?? field.value;
  const done = () => {
    setDraft(undefined);
    if (draft !== undefined && draft !== field.value) commit(draft);
  };
  return (
    <input
      className="pult-settings-input"
      aria-label={field.label}
      value={value}
      placeholder={field.placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key === "Enter") done();
      }}
    />
  );
}

/**
 * A secret field. What is typed lives in this input's state alone until Enter or Save sends it,
 * once, in the instance's write to this environment's server, which empties the input at once;
 * the server stores it apart and sends back only its redaction marker, so the page never holds it
 * after. Clear writes an empty value. A secret provider's reference is shown, not edited.
 */
function SecretInput({
  field,
  write,
  setError,
}: {
  field: SetupField;
  write: (value: string) => Promise<unknown>;
  setError: (error: string | null) => void;
}) {
  const [typed, setTyped] = useState("");
  if (typeof field.secret === "object") {
    return (
      <span className="pult-settings-row-description">
        From {field.secret.from}, change it in T3 Code
      </span>
    );
  }
  const saved = field.secret === "saved";
  const save = () => {
    const value = typed.trim();
    setTyped("");
    if (value === "") return;
    setError(null);
    write(value).catch((failure: unknown) =>
      setError(messageWithout(failure, [value], `Pult could not save the ${field.label}.`)),
    );
  };
  const clear = () => {
    setError(null);
    write("").catch((failure: unknown) => setError(messageOf(failure)));
  };
  return (
    <>
      <input
        className="pult-settings-input"
        type="password"
        aria-label={field.label}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        placeholder={saved ? "Saved · type to replace" : (field.placeholder ?? "Not set")}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      {typed.trim() !== "" ? (
        <button type="button" className="pult-settings-button" onClick={save}>
          Save
        </button>
      ) : saved ? (
        <button type="button" className="pult-settings-button" onClick={clear}>
          Clear
        </button>
      ) : null}
    </>
  );
}

/**
 * The Account subrow: the sign-in's state in words, the server's failure under it, a select of the
 * server's sign-in methods where it lists several, and one button, with Sign Out beside Change
 * Account after the workbench's dialog; then the running flow's interaction under it: a browser
 * sign-in's page and link (consent sent first where the flow asks for it) and, where it takes one,
 * the pasted callback; a device code; a credentials interaction's fields, whose values go to the
 * flow in `provider.auth.respond`, never into settings. A terminal sign-in Pult cannot show reads
 * so, with Cancel.
 */
function AccountSubrows({
  environmentId,
  environmentName,
  provider,
  name,
  account,
  auth,
  failure,
}: {
  environmentId: string;
  environmentName: string;
  provider: ServerProvider;
  name: string;
  account: AccountRow;
  auth: ProviderAuthState | undefined;
  failure: string | null;
}) {
  const { instanceId } = provider;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState("");
  const interaction = auth?.interaction ?? null;
  const flowId = auth?.flowId ?? null;
  // Drafts belong to one interaction of one flow, so a new one starts empty.
  const draftKey = `${flowId ?? ""}:${interaction?.id ?? ""}`;
  const [draft, setDraft] = useState<{
    readonly key: string;
    readonly values: Readonly<Record<string, string>>;
  }>({ key: "", values: {} });
  // What was typed for an interaction that is gone (cancelled, expired, answered) leaves state.
  if (draft.key !== draftKey && draft.key !== "") setDraft({ key: "", values: {} });
  const values = draft.key === draftKey ? draft.values : {};
  const setValue = (field: string, value: string) =>
    setDraft({ key: draftKey, values: { ...values, [field]: value } });
  // A credentials interaction's code comes from the flow's page (Antigravity's personal sign-in).
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : (account.active && interaction === null) || interaction?.type === "credentials"
        ? (auth?.authorizationUrl ?? null)
        : null;
  const takesCallback =
    url !== null &&
    (interaction?.type === "browser" ? interaction.acceptsCallback === true : interaction === null);

  const run = (command: () => Promise<unknown>, typed: ReadonlyArray<string> = []) => {
    if (pending) return Promise.resolve(false);
    setPending(true);
    setError(null);
    return command()
      .then(() => true)
      .catch((failed: unknown) => {
        setError(messageWithout(failed, typed, "The sign-in did not go through. Try again."));
        return false;
      })
      .finally(() => setPending(false));
  };
  const consent = () =>
    interaction?.type === "browser" && interaction.requiresConsent && flowId !== null
      ? send(environmentId, WS_METHODS.providerAuthRespond, {
          instanceId,
          flowId,
          interactionId: interaction.id,
          response: { type: "browser", action: "accept" },
        })
      : Promise.resolve();
  const openPage = (link: string) =>
    run(async () => {
      await consent();
      await (await getService(IOpenerService)).open(link, { openExternal: true });
    });
  const copyLink = (link: string) =>
    run(async () => {
      await copy(link, "sign-in link");
      await consent();
    });
  const act = () => {
    if (account.action === "cancel") {
      if (flowId !== null)
        void run(() => send(environmentId, WS_METHODS.providerAuthCancel, { instanceId, flowId }));
      return;
    }
    const method = account.methods.some((each) => each.id === methodId) ? { methodId } : {};
    void run(() => send(environmentId, WS_METHODS.providerAuthStart, { instanceId, ...method }));
  };
  const signOut = async () => {
    const { confirmed } = await (
      await getService(IDialogService)
    ).confirm({
      message: `Sign out of ${name} on ${environmentName}?`,
      detail: "Threads that share this sign-in stop. Thread history is kept.",
      primaryButton: "Sign Out",
    });
    if (confirmed)
      void run(() => send(environmentId, WS_METHODS.providerAuthLogout, { instanceId }));
  };
  const sendCredentials = () => {
    if (interaction?.type !== "credentials" || flowId === null) return;
    const response = Object.fromEntries(
      interaction.fields.map((field) => [field.name, values[field.name] ?? ""]),
    );
    setDraft({ key: "", values: {} });
    void run(
      () =>
        send(environmentId, WS_METHODS.providerAuthRespond, {
          instanceId,
          flowId,
          interactionId: interaction.id,
          response: { type: "credentials", values: response },
        }),
      Object.values(response),
    );
  };
  const sendCallback = () => {
    const callbackUrl = values.callback?.trim() ?? "";
    if (flowId === null || callbackUrl === "") return;
    setDraft({ key: "", values: {} });
    void run(
      () =>
        send(environmentId, WS_METHODS.providerAuthComplete, { instanceId, flowId, callbackUrl }),
      [callbackUrl],
    );
  };
  const shownError = error ?? failure ?? account.error;

  return (
    <>
      <div className="pult-settings-row pult-settings-subrow pult-settings-setup-row">
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">Account</div>
          {account.description === "" ? null : (
            <div className="pult-settings-row-description">{account.description}</div>
          )}
          {shownError === null ? null : <div className="pult-settings-row-error">{shownError}</div>}
        </div>
        <div className="pult-settings-row-actions">
          {account.methods.length === 0 ? null : (
            <Select
              aria-label="Sign-in method"
              value={methodId}
              disabled={pending}
              onChange={(event) => setMethodId(event.target.value)}
            >
              <option value="">Provider default</option>
              {account.methods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.name}
                </option>
              ))}
            </Select>
          )}
          {url === null ? null : (
            <>
              <button
                type="button"
                className="pult-settings-button"
                disabled={pending}
                onClick={() => void openPage(url)}
              >
                Open Sign-in Page
              </button>
              <button
                type="button"
                className="pult-settings-button"
                disabled={pending}
                onClick={() => void copyLink(url)}
              >
                Copy Link
              </button>
            </>
          )}
          {account.action === null ? null : (
            <button
              type="button"
              className="pult-settings-button"
              disabled={pending || account.blocked}
              title={account.blocked ? account.description : undefined}
              onClick={act}
            >
              {account.actionLabel}
            </button>
          )}
          {account.canSignOut ? (
            <button
              type="button"
              className="pult-settings-button"
              disabled={pending}
              onClick={() => void signOut()}
            >
              Sign Out
            </button>
          ) : null}
        </div>
      </div>
      {interaction?.type === "deviceCode" ? (
        <div className="pult-settings-row pult-settings-subrow">
          <div className="pult-settings-row-text">
            <div className="pult-settings-device-code">{interaction.userCode}</div>
          </div>
          <button
            type="button"
            className="pult-settings-button"
            onClick={() => void copy(interaction.userCode, "code")}
          >
            Copy
          </button>
        </div>
      ) : null}
      {takesCallback ? (
        <div className="pult-settings-row pult-settings-subrow">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-description">
              If the last page in your browser does not load, paste its address here.
            </div>
          </div>
          <div className="pult-settings-row-actions">
            <input
              className="pult-settings-input"
              type="url"
              aria-label="Address of the last page"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:…"
              value={values.callback ?? ""}
              disabled={pending}
              maxLength={16_384}
              onChange={(event) => setValue("callback", event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") sendCallback();
              }}
            />
            <button
              type="button"
              className="pult-settings-button"
              disabled={pending || (values.callback?.trim() ?? "") === ""}
              onClick={sendCallback}
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
      {interaction?.type === "credentials" ? (
        <>
          {interaction.fields.map((field) => (
            <div key={field.name} className="pult-settings-row pult-settings-subrow">
              <div className="pult-settings-row-text">
                <div className="pult-settings-row-label">{field.label}</div>
              </div>
              <input
                className="pult-settings-input"
                type={field.secret ? "password" : "text"}
                aria-label={field.label}
                autoComplete="off"
                spellCheck={false}
                value={values[field.name] ?? ""}
                disabled={pending}
                maxLength={16_384}
                onChange={(event) => setValue(field.name, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendCredentials();
                }}
              />
            </div>
          ))}
          <div className="pult-settings-row pult-settings-subrow">
            <div className="pult-settings-row-text" />
            <button
              type="button"
              className="pult-settings-button"
              disabled={pending}
              onClick={sendCredentials}
            >
              Connect
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
