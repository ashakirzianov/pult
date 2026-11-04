import { getService, IConfigurationService, INotificationService, IQuickInputService, type ServicesAccessor } from "@codingame/monaco-vscode-api";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configurationRegistry";
import { Registry } from "@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform";

import { ConnectedContext } from "../connection/index.ts";
import { showThreads } from "../panel/explorer.ts";
import { writeUserValue } from "../settings/userSetting.ts";
import { limitsShelf, USAGE_LIMITS_MODES, type UsageLimitsMode } from "./limits.ts";
import { limitsStore, refreshLimits, startLimitsModel } from "./model.ts";
import { revealLimits, setLimitsShowAll } from "./shelf.ts";

export { USAGE_LIMITS_MODES, type UsageLimitsMode } from "./limits.ts";

/** The Limits shelf's mode, in the user's settings under Pult. */
const SETTING = "pult.panel.usageLimits";
const DEFAULT_MODE: UsageLimitsMode = "warn";

const isMode = (value: unknown): value is UsageLimitsMode => USAGE_LIMITS_MODES.some(({ mode }) => mode === value);

let mode: UsageLimitsMode = DEFAULT_MODE;
const listeners = new Set<() => void>();

/** The shelf's mode as set, for `useSyncExternalStore`: the default until the configuration is read. */
export const usageLimitsMode = {
  get: () => mode,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export async function setUsageLimitsMode(next: UsageLimitsMode): Promise<void> {
  await writeUserValue(await getService(IConfigurationService), SETTING, next);
}

/** Follows the setting into `usageLimitsMode` once the configuration service is up. */
async function followMode(): Promise<void> {
  const configuration = await getService(IConfigurationService);
  const read = () => {
    const value = configuration.getValue(SETTING);
    const next = isMode(value) ? value : DEFAULT_MODE;
    if (next === mode) return;
    mode = next;
    // A mode picked ends Show all, so the shelf shows what the mode shows.
    setLimitsShowAll(false);
    for (const listener of listeners) listener();
  };
  read();
  configuration.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SETTING)) read();
  });
}

/**
 * The usage limits (xaxis `pult/issues/provider-limits-page`): the setting
 * `pult.panel.usageLimits` under the user's settings' Pult section, the
 * model (`model.ts`), and the palette's Pult: Show Usage Limits, Usage
 * Limits Shelf… (a pick of the modes) and Refresh Usage Limits. The shelf
 * itself is the left panel's (`src/panel/LimitsShelf.tsx`). Registered
 * before the workbench starts.
 */
export function registerLimits(): void {
  Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    // The Pult section `src/mode.ts` opens; the settings editor groups by the title.
    id: "pult",
    title: "Pult",
    order: 1,
    properties: {
      [SETTING]: {
        type: "string",
        enum: USAGE_LIMITS_MODES.map(({ mode }) => mode),
        enumDescriptions: USAGE_LIMITS_MODES.map(({ description }) => description),
        default: DEFAULT_MODE,
        description: "When the left panel's Limits shelf shows the providers' usage limits.",
        scope: ConfigurationScope.APPLICATION,
      },
    },
  });
  const category = { value: "Pult", original: "Pult" };
  registerAction2(
    class extends Action2 {
      constructor() {
        super({ id: "pult-shell.showUsageLimits", title: { value: "Show Usage Limits", original: "Show Usage Limits" }, category, f1: true });
      }

      async run(accessor: ServicesAccessor): Promise<void> {
        const notifications = accessor.get(INotificationService);
        if (limitsShelf(limitsStore.get().accounts, Date.now(), "always", true) === null) {
          notifications.info("Pult: no provider reports any usage of its limits.");
          return;
        }
        // The Pult tab first, so the shelf is laid out when it scrolls into view.
        await showThreads();
        revealLimits();
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectUsageLimitsShelf",
          title: { value: "Usage Limits Shelf…", original: "Usage Limits Shelf…" },
          category,
          f1: true,
        });
      }

      async run(accessor: ServicesAccessor): Promise<void> {
        const quickInput = accessor.get(IQuickInputService);
        const items = USAGE_LIMITS_MODES.map(({ mode, label, description }) => ({ mode, label, description }));
        const picked = await quickInput.pick(items, {
          placeHolder: "When the Limits shelf shows",
          activeItem: items.find((item) => item.mode === usageLimitsMode.get()),
        });
        if (picked !== undefined) await setUsageLimitsMode(picked.mode);
      }
    },
  );
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.refreshUsageLimits",
          title: { value: "Refresh Usage Limits", original: "Refresh Usage Limits" },
          category,
          f1: true,
          precondition: ConnectedContext,
        });
      }

      run(): Promise<void> {
        return refreshLimits();
      }
    },
  );
  startLimitsModel();
  void followMode();
}
