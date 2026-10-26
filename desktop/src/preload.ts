/**
 * The window's preload, sandboxed: it exposes `window.pultDesktop` (the type
 * in `src/desktop/api.ts`) and nothing else, each call one IPC request that
 * main answers only for the page's own origin.
 */
import { contextBridge, ipcRenderer } from "electron";

import type { PultDesktop } from "../../src/desktop/api.ts";
import { Channel, TITLE_BAR_INSET, VERSION_ARG, type Reply } from "./ipc.ts";

async function invoke<T>(channel: string, ...args: string[]): Promise<T> {
  const reply: Reply<T> = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const pultDesktop: PultDesktop = {
  version: process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "",
  secrets: {
    get: (key) => invoke(Channel.secretsGet, key),
    set: (key, value) => invoke(Channel.secretsSet, key, value),
    delete: (key) => invoke(Channel.secretsDelete, key),
    keys: () => invoke(Channel.secretsKeys),
  },
  titleBar: {
    inset: TITLE_BAR_INSET,
    isFullScreen: () => invoke(Channel.windowIsFullScreen),
    onFullScreenChange(listener) {
      const handler = (_event: unknown, fullScreen: boolean) => listener(fullScreen);
      ipcRenderer.on(Channel.windowFullScreen, handler);
      return () => ipcRenderer.off(Channel.windowFullScreen, handler);
    },
  },
};

contextBridge.exposeInMainWorld("pultDesktop", pultDesktop);
