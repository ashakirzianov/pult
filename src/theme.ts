import { getService, IThemeService } from "@codingame/monaco-vscode-api";
import { isDark } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/theme";

/**
 * The workbench theme's colour scheme, a high-contrast theme's folded into
 * light or dark, and a listener called when it flips: the thread view's
 * system scheme (`threads/pane.tsx`) is it.
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
