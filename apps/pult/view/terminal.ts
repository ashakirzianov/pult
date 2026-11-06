// Upstream's terminal drawer under a thread's composer, toggled by the shell's
// Toggle Terminal (`../src/threads/terminal.ts`) as the view's Cmd+J does.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { toggleShellTerminal } from "~/components/chat/shellTerminalToggle";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

/**
 * Toggles the thread's drawer in its mounted view, or with `open` opens it,
 * an open one left open; whether a mounted view took it.
 */
export function toggleTerminal(environmentId: string, threadId: string, open: boolean): boolean {
  const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  const { terminalUiStateByThreadKey } = useTerminalUiStateStore.getState();
  if (open && selectThreadTerminalUiState(terminalUiStateByThreadKey, ref).terminalOpen)
    return true;
  return toggleShellTerminal(scopedThreadKey(ref));
}
