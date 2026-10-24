import { getService, ICommandService } from "@codingame/monaco-vscode-api";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

import { connection } from "./connection.ts";
import type { VirtualSocket } from "./socket.ts";

/**
 * What the shell tells the Pult extension, in order, through its command
 * `pult.shellEvents`: that the environment changed, which the extension then
 * reads with `pult-shell.environment` (any extension can run its command, so
 * the event carries nothing to trust), and the events of the sockets the
 * extension opened. The shape is shared with pult-extension's
 * `src/connection/shell.ts`.
 */
export type ShellEvent =
  | { readonly type: "environment" }
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
 * The environment's routes `pult-shell.fetch` forwards, by method: what the
 * Pult extension calls. Every other route, `/api/auth/*` and `/api/connect/*`
 * among them, is refused, since any extension can run the command.
 */
const ROUTES: ReadonlyArray<readonly [method: string, path: RegExp]> = [
  // The environment's descriptor, which the extension's runtime reads as it connects; public.
  ["GET", /^\/\.well-known\/t3\/environment$/],
  // The thread list's snapshot.
  ["GET", /^\/api\/orchestration\/shell$/],
  // A thread tab's snapshots and history.
  ["GET", /^\/api\/orchestration\/threads\/[^/]+(\/bounded|\/history)?$/],
  // Signed asset URLs: the projects' favicons, the bytes of `pult:` files, a thread tab's images.
  ["GET", /^\/api\/assets\/./],
  // A draft tab's composer attachments and a thread tab's pull request diffs.
  ["POST", /^\/api\/attachments\/upload$/],
  ["POST", /^\/api\/pull-requests\/diff$/],
];

/**
 * The extension's runtime asks for a socket ticket before it dials; its
 * socket is a bridged one (`pult-shell.socket.open`), which ignores the URL
 * the ticket goes in, so the shell answers with a stand-in and a real ticket
 * never leaves the page.
 */
const TICKET_ROUTE = "/api/auth/websocket-ticket";

function standInTicket(): BridgedResponse {
  const ticket = { ticket: "pult-shell", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  return {
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]],
    body: btoa(JSON.stringify(ticket)),
  };
}

/** Whether the shell forwards a request to this path; encoded separators and dots never pass. */
function forwards(method: string, path: string): boolean {
  if (/%(2e|2f|5c)/i.test(path)) return false;
  return ROUTES.some(([allowed, pattern]) => allowed === method && pattern.test(path));
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
  const sockets = new Map<string, VirtualSocket>();
  connection.onDidChange(() => {
    if (subscribed) emit({ type: "environment" });
  });
  // Called once by each extension instance as it starts: the sockets a
  // previous one opened, before its host restarted or crashed, close with it.
  CommandsRegistry.registerCommand("pult-shell.connection", () => {
    subscribed = true;
    for (const socket of sockets.values()) socket.close();
    sockets.clear();
    return connection.environment;
  });
  CommandsRegistry.registerCommand("pult-shell.environment", () => connection.environment);

  // The caller names the socket, so its events can never arrive before it knows the id.
  CommandsRegistry.registerCommand("pult-shell.socket.open", (_accessor, socketId: string) => {
    if (typeof socketId !== "string" || sockets.has(socketId)) throw new Error("pult-shell.socket.open takes a new socket id.");
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
      const credential = connection.credential;
      if (credential === undefined) throw new Error("Pult is not connected to an environment.");
      // The bearer's own server, which a switch changes together with the bearer.
      const url = new URL(request.url);
      if (url.origin !== new URL(credential.httpBaseUrl).origin) {
        throw new Error(`Pult only forwards requests to ${credential.label}.`);
      }
      if (request.method === "POST" && url.pathname === TICKET_ROUTE) return standInTicket();
      if (!forwards(request.method, url.pathname)) {
        console.warn(`[pult-shell] refused ${request.method} ${url.pathname} for an extension`);
        throw new Error(`Pult does not forward ${request.method} ${url.pathname}.`);
      }
      const headers = new Headers(request.headers.map(([name, value]) => [name, value]));
      if (headers.has("authorization")) headers.set("authorization", `Bearer ${credential.token}`);
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
