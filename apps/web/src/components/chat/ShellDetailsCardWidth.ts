// Pult's hook point, not upstream's: the width the app keeps for the details card, which the user
// drags (`apps/pult/view/ThreadDetailsPanel.tsx`). Upstream's app sets none and keeps its fixed width.
import { createContext, use, useSyncExternalStore } from "react";

import type { ShellValue } from "./ShellComposerOptions";

export const ShellDetailsCardWidth = createContext<ShellValue<number> | null>(null);

const NO_WIDTH: ShellValue<number | undefined> = {
  get: () => undefined,
  subscribe: () => () => {},
};

/** The app's width for the details card, or undefined for upstream's. */
export function useShellDetailsCardWidth(): number | undefined {
  const source = use(ShellDetailsCardWidth) ?? NO_WIDTH;
  return useSyncExternalStore(source.subscribe, source.get);
}
