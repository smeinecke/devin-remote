import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { TerminalRunner } from "./terminal.js";
import type { WsServerEvent } from "./types.js";

const KEEPALIVE_MS = 30_000;
const MAX_WS_PAYLOAD = 256 * 1024; // reject obviously oversized frames
const MAX_INPUT_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 10_000;
const MAX_INPUT_MESSAGES_PER_WINDOW = 200;
const MAX_INPUT_BYTES_PER_WINDOW = 1024 * 1024;

const DEBUG = process.env.DEVIN_REMOTE_DEBUG === "1";

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[devin-remote ws]", ...args);
}

interface RateWindow {
  start: number;
  messages: number;
  bytes: number;
}

/** Broadcast hub that also accepts authenticated client-to-server terminal input. */
export class WsHub {
  private wss: WebSocketServer;
  private rateWindows = new WeakMap<WebSocket, RateWindow>();

  constructor(
    server: Server,
    private hello: () => WsServerEvent,
    private terminal: TerminalRunner,
    opts?: { verifyOrigin?: (req: IncomingMessage) => boolean },
  ) {
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: MAX_WS_PAYLOAD,
      // Same CSRF/DNS-rebinding guard as the HTTP API — a WS connection can
      // send prompts and approve permissions, so it must not be reachable
      // from arbitrary web pages.
      verifyClient: (info: { req: IncomingMessage }) => opts?.verifyOrigin?.(info.req) ?? true,
    });
    this.wss.on("connection", (ws) => {
      const client = ws as WebSocket & { isAlive?: boolean };
      client.isAlive = true;
      client.on("pong", () => {
        client.isAlive = true;
      });
      client.on("message", (raw) => this.handleMessage(client, raw));
      client.on("error", (err) => {
        debug("client error", err.message);
      });
      ws.send(JSON.stringify(this.hello()));
    });
    // Keepalive: phones and proxies drop idle sockets silently; ping every
    // 30s and terminate peers that never pong so broadcast() stops queueing
    // into dead connections.
    const timer = setInterval(() => {
      for (const ws of this.wss.clients) {
        const client = ws as WebSocket & { isAlive?: boolean };
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, KEEPALIVE_MS);
    timer.unref();
  }

  broadcast(event: WsServerEvent) {
    const msg = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  clients(): number {
    return this.wss.clients.size;
  }

  private handleMessage(ws: WebSocket, raw: unknown) {
    let rawStr: string;
    if (typeof raw === "string") {
      rawStr = raw;
    } else if (Buffer.isBuffer(raw)) {
      if (raw.length > MAX_INPUT_BYTES * 2) {
        debug("oversized binary frame rejected");
        return;
      }
      rawStr = raw.toString("utf8");
    } else {
      return;
    }

    if (Buffer.byteLength(rawStr, "utf8") > MAX_WS_PAYLOAD) {
      debug("oversized text frame rejected");
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(rawStr);
    } catch {
      debug("malformed JSON ignored");
      return;
    }

    if (typeof msg !== "object" || msg === null) {
      debug("non-object message ignored");
      return;
    }

    const { type } = msg as Record<string, unknown>;
    if (type === "terminal_input") {
      this.handleTerminalInput(ws, msg as Record<string, unknown>);
    } else if (type === "terminal_resize") {
      this.handleTerminalResize(ws, msg as Record<string, unknown>);
    } else {
      debug("unknown message type", type);
    }
  }

  private handleTerminalInput(ws: WebSocket, msg: Record<string, unknown>) {
    const terminalId = msg.terminalId;
    const data = msg.data;
    if (typeof terminalId !== "string" || typeof data !== "string") {
      debug("malformed terminal_input ignored");
      return;
    }
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > MAX_INPUT_BYTES) {
      debug("terminal_input rejected: too large", { terminalId, bytes });
      return;
    }
    if (!this.checkRateLimit(ws, bytes)) {
      debug("terminal_input rejected: rate limit", { terminalId });
      return;
    }
    const ok = this.terminal.write(terminalId, data, sessionId);
    debug("terminal_input", { terminalId, ok, bytes });
    // Never log `data` — it may contain passwords, tokens, or secrets.
  }

  private handleTerminalResize(ws: WebSocket, msg: Record<string, unknown>) {
    const terminalId = msg.terminalId;
    const cols = msg.cols;
    const rows = msg.rows;
    if (
      typeof terminalId !== "string" ||
      typeof cols !== "number" ||
      typeof rows !== "number"
    ) {
      debug("malformed terminal_resize ignored");
      return;
    }
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const ok = this.terminal.resize(terminalId, cols, rows, sessionId);
    debug("terminal_resize", { terminalId, cols, rows, ok });
  }

  private checkRateLimit(ws: WebSocket, bytes: number): boolean {
    const now = Date.now();
    let w = this.rateWindows.get(ws);
    if (!w || now - w.start > RATE_WINDOW_MS) {
      w = { start: now, messages: 0, bytes: 0 };
      this.rateWindows.set(ws, w);
    }
    if (w.messages >= MAX_INPUT_MESSAGES_PER_WINDOW || w.bytes + bytes > MAX_INPUT_BYTES_PER_WINDOW) {
      return false;
    }
    w.messages += 1;
    w.bytes += bytes;
    return true;
  }
}
