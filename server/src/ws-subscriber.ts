/**
 * WebSocket server with session-scoped subscriptions.
 *
 * Clients send:
 *   { type: "subscribe", sessions: { "session-a": { after: 108 }, ... } }
 *
 * Server delivers events newer than `after`. If the cursor is too old, it
 * sends a snapshot. Every event envelope contains sequence numbers.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { EventBus } from "./event-bus.js";
import type { ServerEventEnvelope, SnapshotEnvelope } from "./types.js";
import type { SessionRegistry } from "./session-registry.js";

const KEEPALIVE_MS = 30_000;

interface ClientState {
  ws: WebSocket;
  isAlive: boolean;
  subscriptions: Map<string, { processGeneration: number; after: number }>;
  id: string;
}

export interface WsHello {
  type: "config";
  app: { name: string; version: string };
  settings: unknown;
}

export class WsSubscriber {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();

  constructor(
    server: Server,
    private registry: SessionRegistry,
    private eventBus: EventBus,
    private hello: () => WsHello,
    opts?: { verifyOrigin?: (req: IncomingMessage) => boolean },
  ) {
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: (info: { req: IncomingMessage }) => opts?.verifyOrigin?.(info.req) ?? true,
    });

    this.wss.on("connection", (ws) => {
      const client: ClientState = { ws, isAlive: true, subscriptions: new Map(), id: `c-${Date.now()}` };
      this.clients.set(ws, client);
      ws.send(JSON.stringify(this.hello()));

      ws.on("pong", () => {
        client.isAlive = true;
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(String(data)) as { type: string; sessions?: Record<string, { after?: number; processGeneration?: number }> | string[] };
          if (msg.type === "subscribe" && msg.sessions && !Array.isArray(msg.sessions)) {
            for (const [sessionId, cursor] of Object.entries(msg.sessions)) {
              const controller = this.registry.get(sessionId);
              const requestedGeneration = cursor.processGeneration ?? 0;
              const currentGeneration = controller?.processGeneration ?? requestedGeneration;

              // If the client is subscribing to an obsolete generation, notify
              // it with a top-level control message and subscribe to the current
              // generation instead. Do not rely on the old event buffer still
              // containing the generation_changed event.
              if (controller && requestedGeneration !== currentGeneration) {
                client.subscriptions.set(sessionId, { processGeneration: currentGeneration, after: 0 });
                ws.send(JSON.stringify({
                  type: "generation_changed",
                  sessionId,
                  previousGeneration: requestedGeneration,
                  processGeneration: currentGeneration,
                }));
                this.replayOrSnapshot(ws, sessionId, currentGeneration, 0, controller);
                continue;
              }

              client.subscriptions.set(sessionId, { processGeneration: currentGeneration, after: cursor.after ?? 0 });
              this.replayOrSnapshot(ws, sessionId, currentGeneration, cursor.after ?? 0, controller);
            }
          }
          if (msg.type === "unsubscribe" && Array.isArray(msg.sessions)) {
            for (const sessionId of msg.sessions) {
              client.subscriptions.delete(sessionId);
            }
          }
        } catch {
          /* ignore malformed */
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });

    this.eventBus.subscribe((_sessionId, envelope) => this.broadcast(envelope));

    const timer = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }, KEEPALIVE_MS);
    timer.unref();
  }

  private broadcast(envelope: ServerEventEnvelope | SnapshotEnvelope) {
    const msg = JSON.stringify(envelope);
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      const sub = client.subscriptions.get(envelope.sessionId);
      if (!sub) continue;
      if (envelope.type === "snapshot") {
        if (sub.processGeneration === envelope.processGeneration) client.ws.send(msg);
        continue;
      }
      if (sub.processGeneration !== envelope.processGeneration) continue;
      if (sub.after >= envelope.sequence) continue;
      client.ws.send(msg);
    }
  }

  private replayOrSnapshot(ws: WebSocket, sessionId: string, processGeneration: number, after: number, controller: { snapshot(): unknown } | undefined) {
    const replay = this.eventBus.replay(sessionId, processGeneration, after);
    if (replay === undefined) {
      const snapshot = this.eventBus.snapshot(sessionId, processGeneration, controller?.snapshot() ?? null);
      ws.send(JSON.stringify(snapshot));
    } else {
      for (const ev of replay) {
        ws.send(JSON.stringify(toEnvelope(ev)));
      }
    }
  }

  clientsCount(): number {
    return this.clients.size;
  }

  /** Notify a single client (used for WS-only flows if needed). */
  send(clientId: string, envelope: ServerEventEnvelope | SnapshotEnvelope) {
    for (const client of this.clients.values()) {
      if (client.id === clientId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(envelope));
      }
    }
  }
}

function toEnvelope(ev: { sessionId: string; sequence: number; processGeneration: number; timestamp: number; type: string; payload: unknown }): ServerEventEnvelope {
  return {
    type: "event",
    sessionId: ev.sessionId,
    sequence: ev.sequence,
    processGeneration: ev.processGeneration,
    timestamp: ev.timestamp,
    eventType: ev.type as ServerEventEnvelope["eventType"],
    payload: ev.payload,
  };
}
