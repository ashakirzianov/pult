import { getService, IThemeService } from "@codingame/monaco-vscode-api";
import { isDark } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/theme";

/**
 * The workbench theme's colour scheme, a high-contrast theme's folded into
 * light or dark, and a listener called when it flips: the thread view's
 * system scheme (`threads/pane.tsx`) and the page's `color-scheme`
 * (`syncColorScheme`) are it.
 */
export async function workbenchColorScheme() {
  const themes = await getService(IThemeService);
  const current = () => (isDark(themes.getColorTheme().type) ? "dark" : "light");
  const onDidChange = (listener: () => void) => {
    let scheme = current();
    const subscription = themes.onDidColorThemeChange(() => {
      const next = current();
      if (next === scheme) return;
      scheme = next;
      listener();
    });
    return () => subscription.dispose();
  };
  return { current, onDidChange };
}

/**
 * Keeps the page's `color-scheme` the workbench theme's, so the browser's own
 * scrollbars and form controls follow a light theme too; `style.css` holds
 * the dark one until the workbench is up. Call once, at boot.
 */
export async function syncColorScheme(): Promise<void> {
  const scheme = await workbenchColorScheme();
  const apply = () => {
    document.documentElement.style.colorScheme = scheme.current();
  };
  apply();
  scheme.onDidChange(apply);
}
