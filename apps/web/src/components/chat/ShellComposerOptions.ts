// Pult's hook point, not upstream's: how the app around the view presents one
// mount's composer, and what its sends carry, which upstream's app never sets.
// Pult sets it on a Star's tab and its composer strip (`apps/pult/src/stars/tab.tsx`),
// and on a Star channel's draft (`apps/pult/view/ThreadView.tsx`).
import type { ExtensionComposed, MessageHeader } from "@t3tools/contracts";
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
  /** The header the message that creates a thread from this composer's draft carries (a Star channel's, `messageHeader.ts`); null for none. A reply's header stands in for it. */
  readonly creationHeader: ShellValue<MessageHeader> | null;
  /** The reply this composer's sends are (an answer to a Star's ask); null for a plain message. */
  readonly reply: ShellReply | null;
  /**
   * Hands each send to the app, which answers with the thread it landed in (a composer an
   * extension handles, `extensions.send`): the attachments uploaded, no message drawn, the
   * composer locked and its content kept until the answer, cleared on it, a refusal its error.
   * Its draft becomes no thread, so it shows no environment or branch picker. Null for upstream's send.
   */
  readonly send: ((message: ExtensionComposed) => Promise<unknown>) | null;
}

export interface ShellReply {
  /** The header the sent message carries (`messageHeader.ts`): the line its agent reads above what the user wrote, the caption drawn over it; null where the app's `send` writes it. */
  readonly header: MessageHeader | null;
  /** Where the reply arrives, named on a line above the message input (`ComposerReplySuggestions`) all the while it is written. */
  readonly destination: ShellValue<ShellReplyDestination>;
  /** The replies its poster suggests, offered above the message input (`ComposerReplySuggestions`). */
  readonly suggestions: ShellValue<ReadonlyArray<string>>;
  /** Told as a send starts, its message drawn, with the thread it goes to, a draft's new one included; `sent` or the composer's error follows. */
  readonly sending: (environmentId: string, threadId: string) => void;
  /** Told once a send was accepted, with the thread it went to, a draft's new one included. */
  readonly sent: (environmentId: string, threadId: string) => void;
}

/** A reply's destination as its line names it: "Reply to <name> · <note>". */
export interface ShellReplyDestination {
  readonly name: string;
  /** What the app tells of it after the name (a channel asleep, a thread settled); null for nothing. */
  readonly note: string | null;
  /** Opens the thread the reply goes into, the name drawn as its link; null while there is none yet (a sleeping channel's draft). */
  readonly open: (() => void) | null;
}

/** Upstream's presentation, as its own app has it. */
export const ShellComposerOptions = createContext<ShellComposerOptions>({
  draftHero: true,
  placeholder: null,
  creationTags: null,
  creationHeader: null,
  reply: null,
  send: null,
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

const NO_DESTINATION: ShellValue<ShellReplyDestination | null> = {
  get: () => null,
  subscribe: () => () => {},
};

/** Where this composer's reply arrives; null outside a reply. */
export function useShellReplyDestination(): ShellReplyDestination | null {
  const source = use(ShellComposerOptions).reply?.destination ?? NO_DESTINATION;
  return useSyncExternalStore(source.subscribe, source.get);
}

/** The app's placeholder for the composer, or null for upstream's. */
export function useShellPlaceholder(): string | null {
  const source = use(ShellComposerOptions).placeholder ?? NO_PLACEHOLDER;
  return useSyncExternalStore(source.subscribe, source.get);
}
