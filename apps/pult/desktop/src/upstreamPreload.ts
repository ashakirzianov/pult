/**
 * Pult's part of upstream's desktop preload (`apps/desktop/src/preload.ts`),
 * when Pult's page is its renderer: `window.pultDesktop` beside upstream's
 * `window.desktopBridge`, answered by `upstreamHost.ts`.
 */
import { ipcRenderer } from "electron";

import { exposePultDesktop } from "./bridge.ts";
import { Channel } from "./ipc.ts";

exposePultDesktop(String(ipcRenderer.sendSync(Channel.version) ?? ""));
