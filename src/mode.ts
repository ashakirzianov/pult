import { getService, IConfigurationService, IContextKeyService } from "@codingame/monaco-vscode-api";
import { Action2, registerAction2 } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configurationRegistry";
import { RawContextKey } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { Registry } from "@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform";

import { writeUserValue } from "./settings/userSetting.ts";

/**
 * Pult's mode (xaxis `pult/vscode-mode`): by default Pult's own layout,
 * which hides and rearranges much of VS Code's chrome; VS Code mode shows
 * what the default hides, for an extension that needs it. One setting,
 * `pult.mode`, in the user's settings under Pult.
 */
const MODE = "pult.mode";

export const MODES = [
  { mode: "pult", label: "Pult" },
  { mode: "vscode", label: "VS Code" },
] as const;

export type Mode = (typeof MODES)[number]["mode"];

/**
 * What the mode flips, each thing hidden by default and shown in VS Code
 * mode: the context key `pult.vscodeMode`, for `when` clauses, and the class
 * `pult-mode-vscode` on the workbench's element, for the default-mode rules
 * in `style.css` (the "More Actions" of the editor tabs' row).
 */
const VSCodeModeContext = new RawContextKey<boolean>("pult.vscodeMode", false);
const VSCODE_MODE_CLASS = "pult-mode-vscode";

/** Registers the setting and the palette's switches. Called before the workbench starts. */
export function registerMode(): void {
  Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    id: "pult",
    title: "Pult",
    order: 1,
    properties: {
      [MODE]: {
        type: "string",
        enum: MODES.map(({ mode }) => mode),
        enumDescriptions: [
          "Pult's own layout, which hides and rearranges much of VS Code.",
          "VS Code's layout, with everything Pult's hides.",
        ],
        default: "pult",
        description: "Which layout Pult shows: its own, or VS Code's, for an extension that needs what Pult hides.",
        scope: ConfigurationScope.APPLICATION,
      },
    },
  });
  for (const { mode, label } of MODES) {
    registerAction2(
      class extends Action2 {
        constructor() {
          super({
            id: `pult-shell.switchTo${mode === "pult" ? "Pult" : "VSCode"}Mode`,
            title: { value: `Switch to ${label} Mode`, original: `Switch to ${label} Mode` },
            category: { value: "Pult", original: "Pult" },
            f1: true,
            // Each switch shows while the other mode is on.
            precondition: mode === "pult" ? VSCodeModeContext : VSCodeModeContext.toNegated(),
          });
        }

        run(): Promise<void> {
          return setMode(mode);
        }
      },
    );
  }
}

/** The mode as set, and a listener called when it changes; the Settings page's Mode section shows it. */
export async function modeChoice() {
  const configuration = await getService(IConfigurationService);
  const current = (): Mode => (configuration.getValue(MODE) === "vscode" ? "vscode" : "pult");
  const onDidChange = (listener: () => void) => {
    const subscription = configuration.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(MODE)) listener();
    });
    return () => subscription.dispose();
  };
  return { current, onDidChange };
}

export async function setMode(mode: Mode): Promise<void> {
  await writeUserValue(await getService(IConfigurationService), MODE, mode);
}

/** Applies the mode to the context key and the workbench's class, now and on each change. Called once the workbench is up. */
export async function startMode(): Promise<void> {
  const [choice, contextKeys] = await Promise.all([modeChoice(), getService(IContextKeyService)]);
  const key = VSCodeModeContext.bindTo(contextKeys);
  const apply = () => {
    const vscode = choice.current() === "vscode";
    key.set(vscode);
    document.querySelector(".monaco-workbench")?.classList.toggle(VSCODE_MODE_CLASS, vscode);
  };
  apply();
  choice.onDidChange(apply);
}
