import {
  getService,
  IConfigurationService,
  IContextKeyService,
} from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configurationRegistry";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Registry } from "@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform";

import { writeUserValue } from "../settings/userSetting.ts";

/**
 * Show Star, `pult.star.enabled`, in the user's settings under Pult beside
 * `pult.mode` (`src/mode.ts`): on by default; off hides the Star's card and creates
 * no Star, deleting nothing, the way out of the Star.
 */
const ENABLED = "pult.star.enabled";

/** While the Star is hidden, for the palette's Show Star and Hide Star, each offered in the other state. */
const StarHiddenContext = new RawContextKey<boolean>("pult.starHidden", false);

/** The setting's value as the panel reads it, synchronously, and a listener called when it changes; on until `startStarSettings` reads the user's. */
function settingStore(initial: boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: boolean): void {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Whether the Star shows, read synchronously by the panel, its jumps and the creation (`model.ts`). */
export const starEnabled = settingStore(true);

let known = false;

/** Whether the user's setting has been read, before which no Star is created. */
export const starSettingKnown = () => known;

export async function setStarEnabled(enabled: boolean): Promise<void> {
  await writeUserValue(await getService(IConfigurationService), ENABLED, enabled);
}

/** Registers the setting and the palette's Pult: Show Star and Hide Star. Called before the workbench starts. */
export function registerStarSettings(): void {
  Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    id: "pult",
    title: "Pult",
    order: 1,
    properties: {
      [ENABLED]: {
        type: "boolean",
        default: true,
        description:
          "Whether the left panel shows your Star, Pult's durable agent, and Pult creates one when you have none. Off deletes nothing.",
        scope: ConfigurationScope.APPLICATION,
      },
    },
  });
  for (const enabled of [true, false]) {
    const verb = enabled ? "Show" : "Hide";
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: `pult-shell.${verb.toLowerCase()}Star`,
            title: { value: `${verb} Star`, original: `${verb} Star` },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            precondition: enabled ? StarHiddenContext : StarHiddenContext.toNegated(),
          });
        }

        run(): Promise<void> {
          return setStarEnabled(enabled);
        }
      },
    );
  }
}

/** Reads the setting into its store and the context key, as soon as the services are up and on each change. Called before the workbench initialises. */
export async function startStarSettings(): Promise<void> {
  const [configuration, contextKeys] = await Promise.all([
    getService(IConfigurationService),
    getService(IContextKeyService),
  ]);
  const hidden = StarHiddenContext.bindTo(contextKeys);
  const read = () => {
    const enabled = configuration.getValue(ENABLED) !== false;
    known = true;
    starEnabled.set(enabled);
    hidden.set(!enabled);
  };
  read();
  configuration.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(ENABLED)) read();
  });
}
