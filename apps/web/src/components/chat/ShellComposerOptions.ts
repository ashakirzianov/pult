// Pult's hook point, not upstream's: how the app around the view presents one
// mount's composer, which upstream's app never sets. Pult sets it on a Star's
// tab and its composer strip (`apps/pult/src/stars/tab.tsx`).
import { createContext, use, useSyncExternalStore } from "react";

/** A value the app keeps and changes, read live. */
export interface ShellValue<Value> {
  get(): Value;
  subscribe(listener: () => void): () => void;
}

export interface ShellComposerOptions {
  /** Whether a draft rests on upstream's hero, its headline over a centred composer; false keeps its composer where a thread's sits. */
  readonly draftHero: boolean;
  /** The composer's resting placeholder in place of upstream's default; null for upstream's. */
  readonly placeholder: ShellValue<string> | null;
}

/** Upstream's presentation, as its own app has it. */
export const ShellComposerOptions = createContext<ShellComposerOptions>({
  draftHero: true,
  placeholder: null,
});

const NO_PLACEHOLDER: ShellValue<string | null> = { get: () => null, subscribe: () => () => {} };

/** The app's placeholder for the composer, or null for upstream's. */
export function useShellPlaceholder(): string | null {
  const source = use(ShellComposerOptions).placeholder ?? NO_PLACEHOLDER;
  return useSyncExternalStore(source.subscribe, source.get);
}
