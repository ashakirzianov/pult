import {
  getService,
  IConfigurationService,
  IQuickInputService,
  type ServicesAccessor,
} from "@codingame/monaco-vscode-api";
import {
  Action2,
  registerAction2,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";

import { workbenchColorScheme } from "../theme.ts";

/** The workbench's own theme settings, which the colour scheme reads and writes; Pult keeps none of its own. */
const AUTO_DETECT = "window.autoDetectColorScheme";
const COLOR_THEME = "workbench.colorTheme";
const PREFERRED_THEMES = {
  light: "workbench.preferredLightColorTheme",
  dark: "workbench.preferredDarkColorTheme",
};

/** The colour scheme's choices, in the order the Settings page and the palette's pick list them. */
export const COLOR_SCHEMES = [
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
  { scheme: "system", label: "System" },
] as const;

export type ColorScheme = (typeof COLOR_SCHEMES)[number]["scheme"];

/**
 * The colour scheme as the user chose it, and a listener called when it may
 * have changed: System while the workbench detects the OS's scheme
 * (`window.autoDetectColorScheme`), else Light or Dark from the current
 * theme's type (`src/theme.ts`), so a theme picked in VS Code's Color Theme
 * picker reads back here. The Settings page's Appearance section shows it.
 */
export async function colorSchemeChoice() {
  const [configuration, theme] = await Promise.all([
    getService(IConfigurationService),
    workbenchColorScheme(),
  ]);
  const current = (): ColorScheme =>
    configuration.getValue(AUTO_DETECT) === true ? "system" : theme.current();
  const onDidChange = (listener: () => void) => {
    const subscription = configuration.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(AUTO_DETECT)) listener();
    });
    const stopTheme = theme.onDidChange(listener);
    return () => {
      subscription.dispose();
      stopTheme();
    };
  };
  return { current, onDidChange };
}

/**
 * Applies a colour scheme through the workbench's theme settings, in the
 * user's settings: System turns auto-detection on, and the workbench applies
 * the preferred light or dark theme by the OS's scheme; Light and Dark set
 * the colour theme to the preferred light or dark one, then turn
 * auto-detection off, so the theme flips once.
 */
export async function setColorScheme(scheme: ColorScheme): Promise<void> {
  const configuration = await getService(IConfigurationService);
  if (scheme === "system") return writeUserValue(configuration, AUTO_DETECT, true);
  await writeUserValue(
    configuration,
    COLOR_THEME,
    configuration.getValue(PREFERRED_THEMES[scheme]),
  );
  await writeUserValue(configuration, AUTO_DETECT, false);
}

/** Writes a user setting, or removes it where the value is the default already, so the user's settings hold only what differs. */
function writeUserValue(
  configuration: IConfigurationService,
  key: string,
  value: unknown,
): Promise<void> {
  const { defaultValue } = configuration.inspect(key);
  return configuration.updateValue(
    key,
    value === defaultValue ? undefined : value,
    ConfigurationTarget.USER,
  );
}

/** The palette's "Pult: Colour Scheme…" (`pult-shell.selectColorScheme`), a pick of the three with the current one active. */
export function registerColorSchemeCommand(): void {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: "pult-shell.selectColorScheme",
          title: { value: "Colour Scheme…", original: "Colour Scheme…" },
          category: { value: "Pult", original: "Pult" },
          f1: true,
        });
      }

      async run(accessor: ServicesAccessor): Promise<void> {
        // Services are read before any await; the accessor is only valid synchronously.
        const quickInput = accessor.get(IQuickInputService);
        const current = (await colorSchemeChoice()).current();
        const items = COLOR_SCHEMES.map(({ scheme, label }) => ({
          scheme,
          label,
          description: scheme === "system" ? "Follow the operating system" : undefined,
        }));
        const picked = await quickInput.pick(items, {
          placeHolder: "Select a colour scheme",
          activeItem: items.find((item) => item.scheme === current),
        });
        if (picked !== undefined) await setColorScheme(picked.scheme);
      }
    },
  );
}
