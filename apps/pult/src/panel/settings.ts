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
 * The left panel's settings, in the user's settings under Pult beside
 * `pult.mode` (`src/mode.ts`): which shelves the Pult tab shows. Each is a
 * store the panel, its jumps and the settings page's Panel section read
 * synchronously, `startPanelSettings` keeping it on the user's settings.
 */
const SETTLED = "pult.panel.settled";

export const SETTLED_CHOICES = [
  { value: "shown", label: "Shown" },
  { value: "hidden", label: "Hidden" },
] as const;

export type SettledChoice = (typeof SETTLED_CHOICES)[number]["value"];

/** While the Settled shelf is hidden, for the palette's Show Settled Shelf and Hide Settled Shelf, each offered in the other state. */
const SettledHiddenContext = new RawContextKey<boolean>("pult.settledShelfHidden", false);

/** A setting's value as the panel reads it, synchronously, and a listener called when it changes; its default until `startPanelSettings` reads the user's. */
export function settingStore<Value>(initial: Value) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Value): void {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

/** Whether the Settled shelf shows: hidden, it leaves the panel, its cards, its jumps and its older pages' reads with it (`PanelView.tsx`, `jump.ts`). */
export const settledShelf = settingStore<SettledChoice>("shown");

export async function setSettledShelf(choice: SettledChoice): Promise<void> {
  await writeUserValue(await getService(IConfigurationService), SETTLED, choice);
}

/** Registers the settings and the palette's switches. Called before the workbench starts. */
export function registerPanelSettings(): void {
  Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    id: "pult",
    title: "Pult",
    order: 1,
    properties: {
      [SETTLED]: {
        type: "string",
        enum: SETTLED_CHOICES.map(({ value }) => value),
        enumDescriptions: [
          "The Settled shelf shows at the left panel's bottom.",
          "The left panel shows no Settled shelf; Pult: Open Thread… still reaches settled threads.",
        ],
        default: "shown",
        description: "Whether the left panel shows the Settled shelf.",
        scope: ConfigurationScope.APPLICATION,
      },
    },
  });
  for (const { value } of SETTLED_CHOICES) {
    const verb = value === "shown" ? "Show" : "Hide";
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: `pult-shell.${verb.toLowerCase()}SettledShelf`,
            title: { value: `${verb} Settled Shelf`, original: `${verb} Settled Shelf` },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            precondition:
              value === "shown" ? SettledHiddenContext : SettledHiddenContext.toNegated(),
          });
        }

        run(): Promise<void> {
          return setSettledShelf(value);
        }
      },
    );
  }
}

/** Reads the settings into their stores and the context key, as soon as the services are up and on each change. Called before the workbench initialises. */
export async function startPanelSettings(): Promise<void> {
  const [configuration, contextKeys] = await Promise.all([
    getService(IConfigurationService),
    getService(IContextKeyService),
  ]);
  const settledHidden = SettledHiddenContext.bindTo(contextKeys);
  const readSettled = () => {
    const choice: SettledChoice = configuration.getValue(SETTLED) === "hidden" ? "hidden" : "shown";
    settledShelf.set(choice);
    settledHidden.set(choice === "hidden");
  };
  readSettled();
  configuration.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SETTLED)) readSettled();
  });
}
