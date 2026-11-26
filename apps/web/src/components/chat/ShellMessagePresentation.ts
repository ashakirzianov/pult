// Pult's hook point, not upstream's: how the app around the view draws a message's header
// (`messageHeader.ts`), which upstream's app never sets. Pult provides it in its thread view
// (`apps/pult/view/ThreadView.tsx`); `TimelineUserMessageRow` names a folded message's sender by
// its labels and draws its `caption` in place of "Sent by T3 Code" over an unfolded one.
import type { MessageHeader } from "@t3tools/contracts";
import { createContext, type ReactNode } from "react";

export interface ShellMessagePresentation {
  /** What a folded message names its sender by, over the sender thread's title; null for upstream's. */
  readonly label: string | null;
  /** What it names its sender by where upstream has no title for it, in place of "Agent". */
  readonly fallbackLabel: string;
  /** What an unfolded message draws over its bubble. */
  readonly caption: ReactNode;
}

/** Upstream's presentation, as its own app has it: none. */
export const ShellMessagePresentation = createContext<
  (header: MessageHeader | null, environmentId: string) => ShellMessagePresentation | null
>(() => null);
