import { getService, IDialogService } from "@codingame/monaco-vscode-api";
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
  type ProviderInstallState,
  type ServerConfig,
  type ServerProvider,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  hasUsageProviderIcon,
  UsageProviderIcon,
  usageProvider,
} from "../../view/usageProviders.tsx";
import { connection, environmentName, type ShellEnvironment } from "../connection/index.ts";
import { followServerConfig } from "../connection/serverConfig.ts";
import { instanceWrite, type InstanceChange, providerRow, type RuntimeRow } from "./providers.ts";

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
 * is on and something is owed, and then until the user closes them, else as the user left them. While they are open its install state
 * is followed, and stops with them.
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
  const [error, setError] = useState<string | null>(null);
  const installState = install?._tag === "state" ? install.state : undefined;
  const row = providerRow({ provider, settings: config.settings, install: installState });
  const hasSetup = row.runtime !== null;
  const open = writable && hasSetup && (chosen ?? row.opensByDefault);
  // Rows that opened on their own stay open once what was owed is done, as if the user opened them.
  if (open && chosen === undefined) {
    chosenOpen.set(key, true);
    setChosen(true);
  }
  const followsInstall = open && provider.setup?.canInstall === true;
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

  const toggle = () => {
    chosenOpen.set(key, !open);
    setChosen(!open);
  };
  const write = (change: InstanceChange) => {
    setError(null);
    writeInstance(environmentId, key, provider, change).catch((failure: unknown) =>
      setError(messageOf(failure)),
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
                aria-checked={row.on}
                aria-label={row.name}
                onClick={() => write({ kind: "enabled", on: !row.on })}
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
