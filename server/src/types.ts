// Shared types for the devin-remote server and its web client.

export interface UsageRecord {
  ts: number;
  sessionId: string;
  cwd: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
}

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  title?: string | null;
  alias?: string | null;
  branch?: string | null;
  worktree?: string | null;
  updatedAt?: string | null;
  status?: string | null;
}

export interface StoreShape {
  aliases: Record<string, string>;
  workspaces: string[];
  usage: UsageRecord[];
  sessions: Record<string, SessionMetadata>;
  settings: {
    theme: "dark" | "light" | "system";
    soundComplete: boolean;
    soundNotify: boolean;
    desktopNotify: boolean;
    defaultModel?: string;
    defaultMode?: string;
    worktreeIsolation?: boolean;
  };
}

export type SessionStatus =
  | "starting"
  | "loading"
  | "idle"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "disconnected"
  | "failed"
  | "closed";

/** Legacy event shape — replaced by ServerEventEnvelope in v0.4. */
export interface WsServerEventLegacy {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** New envelope sent over WebSocket. */
export interface ServerEventEnvelope {
  type: "event";
  sessionId: string;
  sequence: number;
  processGeneration: number;
  timestamp: number;
  eventType: string;
  payload: unknown;
}

/** Server-provided materialized session state, when available. */
export interface MaterializedSessionState {
  sessionId: string;
  processGeneration: number;
  status: SessionStatus;
  cwd: string;
  title?: string | null;
  alias?: string | null;
  branch?: string | null;
  worktree?: string | null;
  activeOperation?: string;
  pendingPermissions: unknown[];
  running: boolean;
  latestSequence: number;
}

export interface SnapshotEnvelope {
  type: "snapshot";
  sessionId: string;
  processGeneration: number;
  timestamp: number;
  /** True only when the server is sending a full replacement state. */
  complete: boolean;
  /** Sequence number of the first event in the returned events list, or null if none. */
  baseSequence: number | null;
  /** Sequence number of the newest event known to the server. */
  latestSequence: number;
  state: MaterializedSessionState | null;
  events: ServerEventEnvelope[];
}

export interface GenerationChangedEnvelope {
  type: "generation_changed";
  sessionId: string;
  previousGeneration: number;
  processGeneration: number;
  /** True when the server has already established the subscription and sent replay/snapshot. */
  subscriptionEstablished?: boolean;
}

export type WsServerEvent = ServerEventEnvelope | SnapshotEnvelope | GenerationChangedEnvelope | { type: "config"; app: { name: string; version: string }; settings: StoreShape["settings"] };
