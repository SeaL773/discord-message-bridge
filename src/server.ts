import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { bearerMatches, type BridgeConfig } from "./config.js";
import { EventBuffer } from "./event-buffer.js";
import { EventTailer, type EventTailerTestHooks } from "./tailer.js";
import type { DiscordEvent, EventEnvelope, ReadyFrame } from "./types.js";

interface BridgeServerOptions {
  config: BridgeConfig;
  token: string;
  onError?: (error: unknown) => void;
  maxWebSocketBufferedBytes?: number;
  tailerTestHooks?: EventTailerTestHooks;
}

const MAX_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;

export function webSocketBufferExceeded(bufferedAmount: number, payloadBytes: number, maximum = MAX_WEBSOCKET_BUFFERED_BYTES): boolean {
  return bufferedAmount + payloadBytes > maximum;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(payload);
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 404): void {
  const reason = status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Not Found";
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseRequestUrl(requestUrl: string | undefined): URL | null {
  try {
    return new URL(requestUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null) return 100;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
}

export class BridgeServer {
  readonly #config: BridgeConfig;
  readonly #token: string;
  readonly #buffer: EventBuffer;
  readonly #server: Server;
  readonly #wss: WebSocketServer;
  readonly #tailer: EventTailer;
  readonly #onError: (error: unknown) => void;
  readonly #maxWebSocketBufferedBytes: number;
  readonly #alive = new WeakMap<WebSocket, boolean>();
  #heartbeat: NodeJS.Timeout | null = null;

  public constructor(options: BridgeServerOptions) {
    this.#config = options.config;
    this.#token = options.token;
    this.#onError = options.onError ?? ((error) => console.error(error));
    this.#maxWebSocketBufferedBytes = options.maxWebSocketBufferedBytes ?? MAX_WEBSOCKET_BUFFERED_BYTES;
    this.#buffer = new EventBuffer(options.config.bufferSize);
    this.#server = createServer((request, response) => this.#handleRequest(request, response));
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    this.#tailer = new EventTailer({
      eventPath: options.config.eventPath,
      pollMs: options.config.pollMs,
      onEvent: (event, broadcast) => this.#acceptEvent(event, broadcast),
      onError: this.#onError,
      ...(options.tailerTestHooks === undefined ? {} : { testHooks: options.tailerTestHooks })
    });
    this.#server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));
    this.#wss.on("connection", (socket) => this.#handleConnection(socket));
  }

  public async start(): Promise<void> {
    await this.#tailer.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.#server.off("error", onError);
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        this.#server.once("error", onError);
        try {
          this.#server.listen(this.#config.port, this.#config.host, () => {
            cleanup();
            resolve();
          });
        } catch (error: unknown) {
          cleanup();
          reject(error instanceof Error ? error : new Error("server listen failed"));
        }
      });
    } catch (error: unknown) {
      await this.#tailer.stop();
      throw error;
    }
    this.#heartbeat = setInterval(() => this.#heartbeatClients(), 30_000);
    this.#heartbeat.unref();
  }

  public async stop(): Promise<void> {
    await this.#tailer.stop();
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  public address(): AddressInfo | null {
    const address = this.#server.address();
    return typeof address === "object" ? address : null;
  }

  public async pollOnce(): Promise<void> {
    await this.#tailer.pollOnce();
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const url = parseRequestUrl(request.url);
    if (url === null) {
      json(response, 400, { error: "invalid_url" });
      return;
    }
    if (url.pathname === "/v1/health") {
      const health = this.#tailer.health();
      const healthy = health.running && health.consecutive_poll_errors === 0;
      const now = Date.now();
      json(response, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unhealthy",
        consecutive_poll_errors: health.consecutive_poll_errors,
        last_successful_poll_age_ms: health.last_successful_poll_at === null ? null : Math.max(0, now - health.last_successful_poll_at),
        last_read_progress_age_ms: health.last_read_progress_at === null ? null : Math.max(0, now - health.last_read_progress_at)
      });
      return;
    }
    if (url.pathname !== "/v1/events") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (!bearerMatches(request.headers.authorization, this.#token)) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    if (limit === null) {
      json(response, 400, { error: "invalid_limit" });
      return;
    }
    const after = url.searchParams.get("after");
    const result = this.#buffer.replay(after, limit);
    if (!result.ok) {
      json(response, 409, result);
      return;
    }
    json(response, 200, {
      events: result.events,
      next_cursor: result.next_cursor,
      has_more: result.has_more,
      buffer_latest_cursor: result.buffer_latest_cursor
    });
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = parseRequestUrl(request.url);
    if (url === null) {
      rejectUpgrade(socket, 400);
      return;
    }
    if (url.pathname !== "/v1/events") {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!bearerMatches(request.headers.authorization, this.#token)) {
      rejectUpgrade(socket, 401);
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
      this.#wss.emit("connection", webSocket, request);
    });
  }

  #handleConnection(socket: WebSocket): void {
    this.#alive.set(socket, true);
    socket.on("pong", () => this.#alive.set(socket, true));
    socket.on("error", this.#onError);
    const ready: ReadyFrame = { type: "ready", latest_cursor: this.#buffer.latestCursor() };
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ready));
  }

  #acceptEvent(event: DiscordEvent, broadcast: boolean): void {
    const envelope = this.#buffer.add(event);
    if (envelope !== null && broadcast) this.#broadcast(envelope);
  }

  #broadcast(envelope: EventEnvelope): void {
    const payload = JSON.stringify(envelope);
    const payloadBytes = Buffer.byteLength(payload);
    for (const client of this.#wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (webSocketBufferExceeded(client.bufferedAmount, payloadBytes, this.#maxWebSocketBufferedBytes)) {
        client.terminate();
        continue;
      }
      client.send(payload);
    }
  }

  #heartbeatClients(): void {
    for (const client of this.#wss.clients) {
      if (this.#alive.get(client) === false) {
        client.terminate();
        continue;
      }
      this.#alive.set(client, false);
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }
}
