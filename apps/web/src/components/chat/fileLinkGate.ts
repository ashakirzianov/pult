// Pult's hook point, not upstream's: a gate around a file chip that opens through the right panel,
// drawing its fallback, the path as written, once the app knows the panel's open finds nothing.
// Pult provides it on the thread view's root (`apps/pult/view/fileLinkGate.tsx`); upstream's app
// sets none and draws every chip.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentType, createContext, type ReactNode } from "react";

export interface FileLinkGateProps {
  readonly threadRef: ScopedThreadRef;
  /** What the chip's click hands the right panel's `openFile`. */
  readonly path: string;
  /** Whether the message naming it still streams: the gate asks only once it ends. */
  readonly isStreaming: boolean;
  readonly chip: ReactNode;
  readonly fallback: ReactNode;
}

export const FileLinkGateContext = createContext<ComponentType<FileLinkGateProps> | null>(null);
