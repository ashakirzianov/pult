// Pult's hook point, not upstream's: how the app around the view presents one
// mount's composer, and what its sends carry, which upstream's app never sets.
// Pult sets it on a Star's tab and its composer strip (`apps/pult/src/stars/tab.tsx`),
// and on a Star channel's draft (`apps/pult/view/ThreadView.tsx`).
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
  /** The tags a thread created by this composer's draft is created with (a Star channel's); null for none. */
  readonly creationTags: ReadonlyArray<string> | null;
  /** The reply this composer's sends are (an answer to a Star's ask); null for a plain message. */
  readonly reply: ShellReply | null;
}

export interface ShellReply {
  /** The line the sent message opens with, above what the user wrote. */
  readonly prefix: string;
  /** The replies its poster suggests, offered above the message input (`ComposerReplySuggestions`). */
  readonly suggestions: ShellValue<ReadonlyArray<string>>;
  /** Told once a send was accepted, with the thread it went to, a draft's new one included. */
  readonly sent: (environmentId: string, threadId: string) => void;
}

/** Upstream's presentation, as its own app has it. */
export const ShellComposerOptions = createContext<ShellComposerOptions>({
  draftHero: true,
  placeholder: null,
  creationTags: null,
  reply: null,
});

const NO_PLACEHOLDER: ShellValue<string | null> = { get: () => null, subscribe: () => () => {} };

const NONE: ReadonlyArray<string> = [];
const NO_SUGGESTIONS: ShellValue<ReadonlyArray<string>> = {
  get: () => NONE,
  subscribe: () => () => {},
};

/** The replies the app suggests for this composer's message; none outside a reply. */
export function useShellReplySuggestions(): ReadonlyArray<string> {
  const source = use(ShellComposerOptions).reply?.suggestions ?? NO_SUGGESTIONS;
  return useSyncExternalStore(source.subscribe, source.get);
}

/** The app's placeholder for the composer, or null for upstream's. */
export function useShellPlaceholder(): string | null {
  const source = use(ShellComposerOptions).placeholder ?? NO_PLACEHOLDER;
  return useSyncExternalStore(source.subscribe, source.get);
}
