import { getService, ICommandService, IContextKeyService } from "@codingame/monaco-vscode-api";
import { MenuId } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { IContextMenuService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { type AccessState, followAccess } from "../connection/access.ts";
import { connection, environmentName, type ShellEnvironment } from "../connection/index.ts";
import { pairings } from "../connection/pairDevice.ts";
import { localServerEnabled, setLocalServerEnabled } from "../desktop/localServer.ts";
import { serverExposure, setNetworkAccess } from "../desktop/serverExposure.ts";
import { DAYS, dayNumber, limitsWeekend, setLimitsWeekend } from "../limits/weekend.ts";
import { type modeChoice, setMode } from "../mode.ts";
import { starStore } from "../stars/model.ts";
import { TINTS, tintOf } from "../stars/mark.ts";
import { setStarEnabled, starEnabled } from "../stars/settings.ts";
import { type Star, starName } from "../stars/stars.ts";
import { threadStore } from "../threads/store.ts";
import {
  setStarOrigin,
  setStarRecord,
  starRepositorySync,
  starSyncStore,
  syncStar,
} from "../stars/syncing.ts";
import { COLOR_SCHEMES, type colorSchemeChoice, setColorScheme } from "./colorScheme.ts";
import { AuthorizedClients, PairingCard } from "./EnvironmentAccess.tsx";

function run(command: string, ...args: unknown[]): void {
  void getService(ICommandService).then((commands) => commands.executeCommand(command, ...args));
}

/**
 * The Pult settings page, a tab among the selected thread's (`pane.tsx`):
 * Pult's own settings in groups of rows, then VS Code's, its mode and the
 * workbench's Manage menu behind one button, whose editors open as tabs
 * beside the page.
 */
export function SettingsPage({
  colorScheme,
  mode,
}: {
  colorScheme: ColorSchemeChoice;
  mode: ModeChoice;
}) {
  return (
    <div className="pult-settings">
      <EnvironmentsSection />
      <StarSection />
      <LimitsSection />
      <AppearanceSection colorScheme={colorScheme} />
      <VSCodeSection mode={mode} />
    </div>
  );
}

const PHASES: Record<ShellEnvironment["phase"], string> = {
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  blocked: "Blocked",
};

/**
 * The environments, a group each, so what sits under an environment's row
 * reads as its own: in Pult.app its own server first (`src/desktop/localServer.ts`),
 * held or not, then the others the page holds, in the order they were
 * connected, then Connect to Environment, a group of its own, which adds one.
 * The palette's Pult: Connect to Environment, Disconnect, Retry Connection,
 * Pair Device and Turn On and Turn Off Local Server are the same commands.
 */
function EnvironmentsSection() {
  const environments = useSyncExternalStore(
    (listener) => connection.onDidChange(listener),
    () => connection.environments,
  );
  const localServer = localServerEnabled();
  const local = connection.localEnvironment;
  return (
    <section className="pult-settings-section">
      <h2>Environments</h2>
      {localServer === undefined ? null : local === undefined ? (
        <LocalServerGroup enabled={localServer} />
      ) : (
        <EnvironmentGroup environment={local} environments={environments} local />
      )}
      {environments
        .filter((environment) => environment.environmentId !== local?.environmentId)
        .map((environment) => (
          <EnvironmentGroup
            key={environment.environmentId}
            environment={environment}
            environments={environments}
          />
        ))}
      <div className="pult-settings-group">
        <button
          type="button"
          className="pult-settings-row pult-settings-add"
          onClick={() => run("pult-shell.connect")}
        >
          <i className="codicon codicon-add" aria-hidden />
          Connect to Environment…
        </button>
      </div>
      {environments.length === 0 ? (
        <p className="pult-settings-footnote">Pult is not connected to an environment.</p>
      ) : null}
    </section>
  );
}

/**
 * An environment's group, the environment over a line across the group, its
 * devices under it. The environment: its row, the environments' icon before
 * its name, its host, how its connection stands and why when it is not ready,
 * Retry while it is not, and Disconnect; `local`, Pult.app's own server, has
 * This computer in its row, the local server's switch in Disconnect's place,
 * since off is how the app lets go of it, and under the row whether other
 * devices reach it. Its devices, while it is ready or something is known of
 * them: Devices, with Pair Device while it is ready, the pairing link that
 * minted, until it expires and, once the environment's access is known, while
 * it is still outstanding, then that access, followed while the group shows
 * (`EnvironmentAccess.tsx`).
 */
function EnvironmentGroup({
  environment,
  environments,
  local = false,
}: {
  environment: ShellEnvironment;
  environments: ReadonlyArray<ShellEnvironment>;
  local?: boolean;
}) {
  const { environmentId } = environment;
  const [access, setAccess] = useState<AccessState>();
  useEffect(() => followAccess(environmentId, setAccess), [environmentId]);
  const pairing = useSyncExternalStore(pairings.subscribe, pairings.get).get(environmentId);
  const outstanding =
    pairing !== undefined &&
    (access?._tag !== "snapshot" ||
      access.snapshot.pairingLinks.some((link) => link.id === pairing.id));
  const ready = environment.phase === "ready";
  return (
    <div className="pult-settings-group">
      <div className="pult-settings-row">
        <EnvironmentIcon phase={environment.phase} />
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">
            {environmentName(environment, environments)}
          </div>
          <div className="pult-settings-row-description">
            {[local ? "This computer" : undefined, hostOf(environment), PHASES[environment.phase]]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </div>
          {environment.error === null ? null : (
            <div className="pult-settings-row-error">{environment.error}</div>
          )}
        </div>
        <div className="pult-settings-row-actions">
          {ready ? null : (
            <button
              type="button"
              className="pult-settings-button"
              onClick={() => run("pult-shell.retryConnection", environmentId)}
            >
              Retry
            </button>
          )}
          {local ? (
            <LocalServerSwitch enabled />
          ) : (
            <button
              type="button"
              className="pult-settings-button"
              onClick={() => run("pult-shell.disconnect", environmentId)}
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
      {local ? <ReachableRow /> : null}
      {ready || outstanding || access !== undefined ? (
        <div className="pult-settings-row pult-settings-subrow pult-settings-devices">
          <h3 className="pult-settings-row-text">Devices</h3>
          {ready ? (
            <button
              type="button"
              className="pult-settings-button"
              onClick={() => run("pult-shell.pairDevice", environmentId)}
            >
              Pair Device…
            </button>
          ) : null}
        </div>
      ) : null}
      {outstanding ? <PairingCard key={pairing.id} pairing={pairing} /> : null}
      <AuthorizedClients environmentId={environmentId} access={access} />
    </div>
  );
}

/**
 * An environment's mark, a computer, with a dot at its corner in the colour of
 * how its connection stands: `off` for Pult.app's own server turned off, and
 * no phase while it is on and not connected.
 */
function EnvironmentIcon({ phase }: { phase: ShellEnvironment["phase"] | "off" | undefined }) {
  return (
    <span className="pult-settings-environment" aria-hidden>
      <i className="codicon codicon-device-desktop" />
      <span className="pult-settings-dot" data-phase={phase} />
    </span>
  );
}

/**
 * In Pult.app, its own server while the page holds no environment of it: off,
 * as the app started, or on and not connected. The switch is the one its
 * environment's row carries once the page holds it.
 */
function LocalServerGroup({ enabled }: { enabled: boolean }) {
  return (
    <div className="pult-settings-group">
      <div className="pult-settings-row">
        <EnvironmentIcon phase={enabled ? undefined : "off"} />
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">This computer</div>
          <div className="pult-settings-row-description">
            {enabled ? "Not connected" : "Off. Turn on to run agents on this computer."}
          </div>
        </div>
        <LocalServerSwitch enabled={enabled} />
      </div>
    </div>
  );
}

/** Pult.app's local server, on or off as the app started; a change asks, then relaunches the app. */
function LocalServerSwitch({ enabled }: { enabled: boolean }) {
  return (
    <Switch
      label="Local server"
      title={enabled ? "Turn Off Local Server…" : "Turn On Local Server…"}
      checked={enabled}
      onChange={(on) => void setLocalServerEnabled(on)}
    />
  );
}

/**
 * Under Pult.app's own server's row, whether other devices reach it
 * (`src/desktop/serverExposure.ts`), which a pairing link of it needs; a
 * change asks, then relaunches the app.
 */
function ReachableRow() {
  const exposure = useSyncExternalStore(serverExposure.subscribe, serverExposure.get);
  if (exposure === undefined) return null;
  return (
    <div className="pult-settings-row pult-settings-subrow">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">Reachable from other devices</div>
        <div className="pult-settings-row-description">
          Devices on your network can connect to this computer's server.
        </div>
      </div>
      <Switch
        label="Reachable from other devices"
        checked={exposure === "network-accessible"}
        onChange={(on) => void setNetworkAccess(on)}
      />
    </div>
  );
}

/**
 * The Star (`src/stars/`): per Star the page holds, a group of its Name and
 * Tint, written into the record of every home the page holds, its
 * Instructions (its own `instructions.md` as a tab) and its Folder (the
 * explorer at its folder); then the Stars' Sync, once for all of them; then
 * Show Star (`pult.star.enabled`), a switch, which the palette's Show Star
 * and Hide Star set too: off, the left panel shows no Star's card and Pult
 * creates none, deleting nothing.
 */
function StarSection() {
  const stars = useSyncExternalStore(starStore.subscribe, starStore.get);
  const enabled = useSyncExternalStore(starEnabled.subscribe, starEnabled.get);
  return (
    <section className="pult-settings-section">
      <h2>Star</h2>
      {stars.map((star) => (
        <StarSettings key={star.id} star={star} several={stars.length > 1} />
      ))}
      {stars.length === 0 ? null : <StarSyncGroup stars={stars} />}
      <div className="pult-settings-group">
        <SwitchRow
          label="Show Star"
          description="Off, Pult shows and creates no Star. Nothing is deleted."
          checked={enabled}
          onChange={(on) => void setStarEnabled(on)}
        />
      </div>
      {stars.length === 0 && enabled ? (
        <p className="pult-settings-footnote">
          Pult creates your Star once it is connected to an environment.
        </p>
      ) : null}
    </section>
  );
}

function StarSettings({ star, several }: { star: Star; several: boolean }) {
  const [name, setName] = useState(star.name);
  const [editing, setEditing] = useState(false);
  // The record's name, as a write here or a hand edit of the front matter changes it, unless the field is being edited.
  const shown = editing ? name : star.name;
  // Escape leaves the field through its blur, which this tells to write nothing: the blur's `name` is still the typed one.
  const cancelled = useRef(false);
  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (name.trim() !== star.name) void setStarRecord(star.id, { name: name.trim() });
  };
  return (
    <div className="pult-settings-group">
      <div className="pult-settings-row">
        <div className="pult-settings-row-text">
          <label className="pult-settings-row-label" htmlFor={`pult-star-name-${star.id}`}>
            {several ? `Name of ${starName(star)}` : "Name"}
          </label>
        </div>
        <input
          id={`pult-star-name-${star.id}`}
          className="pult-settings-input"
          type="text"
          placeholder="Star"
          spellCheck
          value={shown}
          onFocus={() => {
            setName(star.name);
            setEditing(true);
          }}
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelled.current = true;
              setName(star.name);
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className="pult-settings-row">
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">Tint</div>
        </div>
        <div className="pult-settings-swatches" role="radiogroup" aria-label="Tint">
          {TINTS.map((tint) => (
            <button
              key={tint.name}
              type="button"
              role="radio"
              className="pult-settings-swatch"
              aria-checked={tint.name === tintOf(star.tint).name}
              title={tint.name[0]?.toUpperCase() + tint.name.slice(1)}
              style={{ background: `hsl(${tint.hue} 80% 60%)` }}
              onClick={() => void setStarRecord(star.id, { tint: tint.name })}
            />
          ))}
        </div>
      </div>
      <div className="pult-settings-row">
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">Instructions</div>
          <div className="pult-settings-row-description">
            Read at the start of every conversation.
          </div>
        </div>
        <button
          type="button"
          className="pult-settings-button"
          onClick={() => run("pult-shell.editStarInstructions", star.id)}
        >
          Edit…
        </button>
      </div>
      <div className="pult-settings-row">
        <div className="pult-settings-row-text">
          <div className="pult-settings-row-label">Folder</div>
          <div className="pult-settings-row-description">Where your Star keeps what it needs.</div>
        </div>
        <button
          type="button"
          className="pult-settings-button"
          onClick={() => run("pult-shell.openStarFolder", star.id)}
        >
          Open
        </button>
      </div>
    </div>
  );
}

/**
 * The Stars' Sync (`src/stars/syncing.ts`): the origin of their repository,
 * each environment's Stars directory, a Git URL or a repository's path on the environment,
 * written on Enter or leaving the field into every held environment's
 * repository, empty to stop syncing; Sync Now while it is set; a line per
 * environment of when it last synced, what failed, and what waits or was
 * handed to a Star; and under the group, what syncing does.
 */
function StarSyncGroup({ stars }: { stars: ReadonlyArray<Star> }) {
  useSyncExternalStore(starSyncStore.subscribe, starSyncStore.get);
  const origin = stars.find((star) => star.origin !== undefined)?.origin ?? "";
  const [typed, setTyped] = useState(origin);
  const [editing, setEditing] = useState(false);
  // Escape leaves the field through its blur, which this tells to write nothing, as the name's does.
  const cancelled = useRef(false);
  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (typed.trim() !== origin) void setStarOrigin(typed.trim());
  };
  const homes = [
    ...new Map(
      stars.flatMap((star) => star.homes.map((home) => [home.environmentId, home] as const)),
    ).values(),
  ];
  const lines = homes.flatMap((home) => {
    const state = starRepositorySync(home.environmentId);
    const where =
      homes.length > 1
        ? `${threadStore.environment(home.environmentId)?.name ?? home.environmentId}: `
        : "";
    if (home.origin === undefined)
      return state?.note == null && state?.failure == null
        ? []
        : [{ text: `${where}${state.failure ?? state.note}`, error: state.failure !== null }];
    const last =
      state?.lastSync == null
        ? "Not synced yet."
        : `Last synced ${new Date(state.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    return [
      { text: `${where}${state?.busy ?? last}`, error: false },
      ...(state?.failure == null ? [] : [{ text: `${where}${state.failure}`, error: true }]),
      ...(state?.note == null ? [] : [{ text: `${where}${state.note}`, error: false }]),
    ];
  });
  const first = stars[0];
  return (
    <>
      <div className="pult-settings-group">
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <label className="pult-settings-row-label" htmlFor="pult-star-origin">
              Sync
            </label>
            {lines.map((line) => (
              <div
                key={line.text}
                className={line.error ? "pult-settings-row-error" : "pult-settings-row-description"}
              >
                {line.text}
              </div>
            ))}
          </div>
          <div className="pult-settings-row-actions">
            <input
              id="pult-star-origin"
              className="pult-settings-input pult-settings-input-origin"
              type="text"
              placeholder="git@host:you/star.git"
              spellCheck={false}
              value={editing ? typed : origin}
              onFocus={() => {
                setTyped(origin);
                setEditing(true);
              }}
              onChange={(event) => setTyped(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  cancelled.current = true;
                  setTyped(origin);
                  event.currentTarget.blur();
                }
              }}
            />
            {origin === "" ? null : (
              <button
                type="button"
                className="pult-settings-button"
                onClick={() => first !== undefined && void syncStar(first.id)}
              >
                Sync Now
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="pult-settings-footnote">
        A Git repository your Stars sync with: Pult commits after each conversation, then pushes,
        and pulls before a Star wakes. Empty, it only commits.
      </p>
    </>
  );
}

function hostOf(environment: ShellEnvironment): string | undefined {
  return URL.canParse(environment.httpBaseUrl) ? new URL(environment.httpBaseUrl).host : undefined;
}

type ColorSchemeChoice = Awaited<ReturnType<typeof colorSchemeChoice>>;

/**
 * The colour scheme, Light, Dark or System, one button each, the current one
 * pressed, following the workbench's theme settings however they change:
 * here, the palette's Pult: Colour Scheme… or VS Code's own Color Theme
 * picker (`colorScheme.ts`).
 */
function AppearanceSection({ colorScheme }: { colorScheme: ColorSchemeChoice }) {
  const current = useSyncExternalStore(colorScheme.onDidChange, colorScheme.current);
  return (
    <section className="pult-settings-section">
      <h2>Appearance</h2>
      <div className="pult-settings-group">
        <SegmentedRow
          label="Colour scheme"
          choices={COLOR_SCHEMES.map(({ scheme, label }) => ({ value: scheme, label }))}
          current={current}
          onChoose={(scheme) => void setColorScheme(scheme)}
        />
      </div>
    </section>
  );
}

/**
 * The usage limits' Weekend (`pult.limits.weekend`, `src/limits/weekend.ts`):
 * a round button per day, Monday first, pressed while the day is a weekend day,
 * which the Limits shelf's pace counts no time on; Saturday and Sunday by
 * default, none for a pace by the calendar.
 */
function LimitsSection() {
  const weekend = useSyncExternalStore(limitsWeekend.subscribe, limitsWeekend.get);
  const days = DAYS.filter((day) => weekend.has(dayNumber(day)));
  return (
    <section className="pult-settings-section">
      <h2>Limits</h2>
      <div className="pult-settings-group">
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">Weekend</div>
            <div className="pult-settings-row-description">
              A limit's pace counts no time on these days.
            </div>
          </div>
          <div className="pult-settings-days" role="group" aria-label="Weekend">
            {DAYS.map((day) => {
              const pressed = days.includes(day);
              const name = day.charAt(0).toUpperCase() + day.slice(1);
              return (
                <button
                  key={day}
                  type="button"
                  className="pult-settings-day"
                  aria-pressed={pressed}
                  aria-label={name}
                  title={name}
                  onClick={() =>
                    void setLimitsWeekend(
                      pressed ? days.filter((other) => other !== day) : [...days, day],
                    )
                  }
                >
                  {name.charAt(0)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

type ModeChoice = Awaited<ReturnType<typeof modeChoice>>;

/** A setting's row of one button per choice, the current one pressed. */
function SegmentedRow<Value extends string>({
  label,
  choices,
  current,
  onChoose,
}: {
  label: string;
  choices: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  current: Value;
  onChoose: (value: Value) => void;
}) {
  return (
    <div className="pult-settings-row">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">{label}</div>
      </div>
      <div className="pult-settings-segments" role="group" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="pult-settings-segment"
            aria-pressed={choice.value === current}
            onClick={() => onChoose(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A setting's row with a switch, on or off. */
function SwitchRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="pult-settings-row">
      <div className="pult-settings-row-text">
        <div className="pult-settings-row-label">{label}</div>
        <div className="pult-settings-row-description">{description}</div>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

/** A switch, named by `label`; `title` says what it does where no label beside it does. */
function Switch({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="pult-settings-switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * VS Code: the mode (`src/mode.ts`), a switch, on in VS Code mode, the
 * setting the palette's Switch to VS Code Mode and Switch to Pult Mode set;
 * and the workbench's Manage menu, which the stock activity bar's gear would
 * show; the shell hides that bar, its own gear opening this page
 * (`src/panel/rows.tsx`): one button opening the menu as the context menu
 * the stock gear opens, so VS Code's settings editor, keyboard
 * shortcuts, profiles, themes and extensions stay a click away.
 */
function VSCodeSection({ mode }: { mode: ModeChoice }) {
  const current = useSyncExternalStore(mode.onDidChange, mode.current);
  const button = useRef<HTMLButtonElement>(null);
  const showManageMenu = async () => {
    const anchor = button.current;
    if (anchor === null) return;
    const [contextMenus, contextKeys] = await Promise.all([
      getService(IContextMenuService),
      getService(IContextKeyService),
    ]);
    contextMenus.showContextMenu({
      menuId: MenuId.GlobalActivity,
      menuActionOptions: { renderShortTitle: true },
      contextKeyService: contextKeys,
      getAnchor: () => anchor,
    });
  };
  return (
    <section className="pult-settings-section">
      <h2>VS Code</h2>
      <div className="pult-settings-group">
        <SwitchRow
          label="VS Code mode"
          description="Show all of VS Code's interface, for an extension that needs it."
          checked={current === "vscode"}
          onChange={(on) => void setMode(on ? "vscode" : "pult")}
        />
        <div className="pult-settings-row">
          <div className="pult-settings-row-text">
            <div className="pult-settings-row-label">
              Settings, shortcuts, themes and extensions
            </div>
          </div>
          <button
            ref={button}
            type="button"
            className="pult-settings-button"
            onClick={() => void showManageMenu()}
          >
            Open Menu…
          </button>
        </div>
      </div>
    </section>
  );
}
