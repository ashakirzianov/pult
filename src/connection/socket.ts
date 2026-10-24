import type * as Socket from "effect/socket/Socket";

import { SocketMux } from "./mux.ts";

type EventType = "open" | "message" | "error" | "close";
type Listener = (event: Socket.WebSocketEvent) => void;

/**
 * A real socket as the page's runtime sees it: the server's frames, less those
 * addressed to bridged clients, which its multiplexer routes to them.
 */
class TappedWebSocket implements Socket.WebSocketLike {
  readonly mux: SocketMux;
  private readonly socket: WebSocket;
  private readonly listeners = new Map<EventType, Map<Listener, boolean>>();

  constructor(socket: WebSocket, hub: PageSocket) {
    this.socket = socket;
    this.mux = new SocketMux((frame) => socket.send(frame));
    socket.addEventListener("open", (event) => {
      hub.opened(this);
      this.dispatch("open", event);
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return this.dispatch("message", event);
      const own = this.mux.fromServer(event.data);
      if (own === undefined) return;
      this.dispatch("message", own === event.data ? event : { type: "message", data: own });
    });
    socket.addEventListener("error", (event) => this.dispatch("error", event));
    socket.addEventListener("close", (event) => {
      hub.closed(this);
      this.dispatch("close", event);
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(type: BinaryType) {
    this.socket.binaryType = type;
  }

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    let byType = this.listeners.get(type);
    if (byType === undefined) this.listeners.set(type, (byType = new Map()));
    byType.set(listener, options?.once === true);
  }

  removeEventListener(type: EventType, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    this.socket.send(data);
  }

  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }

  private dispatch(type: EventType, event: Socket.WebSocketEvent) {
    const byType = this.listeners.get(type);
    if (byType === undefined) return;
    for (const [listener, once] of byType) {
      if (once) byType.delete(listener);
      listener(event);
    }
  }
}

/** What a bridged client's socket hears: what a WebSocket's events would say. */
export interface VirtualSocketEvents {
  readonly opened: () => void;
  readonly message: (data: string) => void;
  readonly closed: (code: number, reason: string) => void;
}

export interface VirtualSocket {
  send(data: string): void;
  close(): void;
}

interface Client {
  readonly events: VirtualSocketEvents;
  socket: TappedWebSocket | undefined;
}

/**
 * The page's one socket to its environment, which the shell's runtime dials
 * through `webSocketConstructor`. A bridged client attaches to whichever real
 * socket is open, waits for the next one otherwise, and closes with it, as the
 * extension's webviews do on its host's socket.
 */
export class PageSocket {
  private current: TappedWebSocket | undefined;
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;

  readonly webSocketConstructor = (url: string, options?: Socket.WebSocketConstructorOptions) => {
    if (typeof options === "object" && !Array.isArray(options)) {
      throw new Error("A browser WebSocket cannot set handshake headers.");
    }
    return new TappedWebSocket(new WebSocket(url, options), this);
  };

  /** How many bridged clients are open, attached or waiting: `window.pult.bridgedSockets()`. */
  get clientCount(): number {
    return this.clients.size;
  }

  open(events: VirtualSocketEvents): VirtualSocket {
    const clientId = this.nextClientId++;
    const client: Client = { events, socket: undefined };
    this.clients.set(clientId, client);
    if (this.current !== undefined) this.attach(clientId, client, this.current);
    return {
      send: (data) => client.socket?.mux.fromClient(clientId, data),
      close: () => {
        client.socket?.mux.detach(clientId);
        this.clients.delete(clientId);
      },
    };
  }

  /** @internal */
  opened(socket: TappedWebSocket) {
    this.current = socket;
    for (const [clientId, client] of this.clients) {
      if (client.socket === undefined) this.attach(clientId, client, socket);
    }
  }

  /** @internal */
  closed(socket: TappedWebSocket) {
    if (this.current === socket) this.current = undefined;
    for (const [clientId, client] of this.clients) {
      if (client.socket !== socket) continue;
      this.clients.delete(clientId);
      client.events.closed(1006, "The page's connection closed.");
    }
  }

  private attach(clientId: number, client: Client, socket: TappedWebSocket) {
    client.socket = socket;
    socket.mux.attach(clientId, client.events.message);
    client.events.opened();
  }
}
