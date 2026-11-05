/**
 * `window.pultDesktop` (the type in `src/desktop/api.ts`), as a sandboxed
 * preload exposes it: each call one IPC request that main answers only for
 * the page's own origin. The wrapper's preload (`preload.ts`) and upstream's
 * (`upstreamPreload.ts`) both expose it; they differ in how they learn the
 * app's version.
 */
import { contextBridge, ipcRenderer } from "electron";

import type { PultDesktop } from "../../src/desktop/api.ts";
import { Channel, type Reply } from "./ipc.ts";

async function invoke<T>(channel: string, ...args: string[]): Promise<T> {
  const reply: Reply<T> = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function exposePultDesktop(version: string): void {
  const pultDesktop: PultDesktop = {
    version,
    secrets: {
      get: (key) => invoke(Channel.secretsGet, key),
      set: (key, value) => invoke(Channel.secretsSet, key, value),
      delete: (key) => invoke(Channel.secretsDelete, key),
      keys: () => invoke(Channel.secretsKeys),
    },
    titleBar: {
      layout: () => invoke(Channel.windowTitleBarLayout),
      onFullScreenChange(listener) {
        const handler = (_event: unknown, fullScreen: boolean) => listener(fullScreen);
        ipcRenderer.on(Channel.windowFullScreen, handler);
        return () => ipcRenderer.off(Channel.windowFullScreen, handler);
      },
    },
  };
  contextBridge.exposeInMainWorld("pultDesktop", pultDesktop);
}
