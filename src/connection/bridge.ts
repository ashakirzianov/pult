import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

import { connection, type ShellEnvironment } from "./connection.ts";
import type { VirtualSocket } from "./socket.ts";

/**
 * What the shell tells the Pult extension, in order, through its command
 * `pult.shellEvents`: the environment as it changes, and the events of the
 * sockets the extension opened. The shape is shared with pult-extension's
 * `src/connection/shell.ts`.
 */
export type ShellEvent =
  | { readonly type: "environment"; readonly environment: ShellEnvironment | null }
  | { readonly type: "socket.opened"; readonly socketId: string }
  | { readonly type: "socket.message"; readonly socketId: string; readonly data: string }
  | { readonly type: "socket.closed"; readonly socketId: string; readonly code: number; readonly reason: string };

/** A request the shell sends to the environment for the extension, bodies in base64. */
export interface BridgedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string | null;
}

export interface BridgedResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

let queue: Array<ShellEvent> = [];
let flushing = false;

/** Sends queued events one batch at a time, so the extension sees them in order. */
function emit(event: ShellEvent): void {
  queue.push(event);
  if (flushing) return;
  flushing = true;
  void (async () => {
    const commands = await getService(ICommandService);
    while (queue.length > 0) {
      const batch = queue;
      queue = [];
      await commands.executeCommand("pult.shellEvents", batch).catch((error: unknown) => {
        console.warn("[pult-shell] the extension missed shell events", error);
      });
    }
    flushing = false;
  })();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * The page's connection offered to the Pult extension over main-thread
 * commands, the pattern of `pult-shell.threads`: in Pult the extension runs
 * its runtime over a socket the shell multiplexes onto the page's one socket
 * (`socket.ts`), and its HTTP requests to the environment go through the
 * shell, which adds the bearer, so the bearer never leaves the page.
 * `pult-shell.connection` answers the environment and subscribes the caller
 * to its changes.
 */
export function registerConnectionBridge(): void {
  let subscribed = false;
  connection.onDidChange(() => {
    if (subscribed) emit({ type: "environment", environment: connection.environment });
  });
  CommandsRegistry.registerCommand("pult-shell.connection", () => {
    subscribed = true;
    return connection.environment;
  });

  const sockets = new Map<string, VirtualSocket>();
  CommandsRegistry.registerCommand("pult-shell.socket.open", () => {
    const socketId = crypto.randomUUID();
    sockets.set(
      socketId,
      connection.socket.open({
        opened: () => emit({ type: "socket.opened", socketId }),
        message: (data) => emit({ type: "socket.message", socketId, data }),
        closed: (code, reason) => {
          sockets.delete(socketId);
          emit({ type: "socket.closed", socketId, code, reason });
        },
      }),
    );
    return socketId;
  });
  CommandsRegistry.registerCommand("pult-shell.socket.send", (_accessor, socketId: string, data: string) => {
    sockets.get(socketId)?.send(data);
  });
  CommandsRegistry.registerCommand("pult-shell.socket.close", (_accessor, socketId: string) => {
    sockets.get(socketId)?.close();
    sockets.delete(socketId);
  });

  CommandsRegistry.registerCommand(
    "pult-shell.fetch",
    async (_accessor, request: BridgedRequest): Promise<BridgedResponse> => {
      const environment = connection.environment;
      const bearer = connection.bearer;
      if (environment === null || bearer === undefined) throw new Error("Pult is not connected to an environment.");
      if (new URL(request.url).origin !== new URL(environment.httpBaseUrl).origin) {
        throw new Error(`Pult only forwards requests to ${environment.label}.`);
      }
      const headers = new Headers(request.headers.map(([name, value]) => [name, value]));
      if (headers.has("authorization")) headers.set("authorization", `Bearer ${bearer}`);
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.body === null ? null : fromBase64(request.body),
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
        body: toBase64(new Uint8Array(await response.arrayBuffer())),
      };
    },
  );
}
