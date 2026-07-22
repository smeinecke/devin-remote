import { dispatchEvent, refreshSessions, setWsConnected } from "./state";
import type { ServerEventEnvelope, SnapshotEnvelope, WsConfigEvent, WsServerEvent } from "./types";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let attempts = 0;

/** sessionId -> { processGeneration, after } */
const cursors = new Map<string, { processGeneration: number; after: number }>();

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function startWs(): void {
  if (started) return;
  started = true;
  connect();
}

export function setCursor(sessionId: string, processGeneration: number, after: number): void {
  const cursor = { processGeneration, after };
  cursors.set(sessionId, cursor);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "subscribe", sessions: { [sessionId]: cursor } }));
  }
}

export function removeCursor(sessionId: string): void {
  cursors.delete(sessionId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unsubscribe", sessions: [sessionId] }));
  }
}

function subscribeAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (cursors.size === 0) return;
  const sessions: Record<string, { processGeneration: number; after: number }> = {};
  for (const [id, c] of cursors) sessions[id] = c;
  ws.send(JSON.stringify({ type: "subscribe", sessions }));
}

function connect(): void {
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    attempts = 0;
    setWsConnected(true);
    void refreshSessions();
    subscribeAll();
  };

  ws.onmessage = (e) => {
    let ev: WsServerEvent;
    try {
      ev = JSON.parse(String(e.data)) as WsServerEvent;
    } catch {
      return;
    }
    dispatchEvent(ev);
  };

  ws.onclose = () => {
    setWsConnected(false);
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4));
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export { cursors };
