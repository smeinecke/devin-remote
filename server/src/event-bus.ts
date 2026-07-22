/**
 * In-memory, sequenced, per-session/per-generation event bus.
 *
 * Each (sessionId, processGeneration) pair gets its own monotonic sequence
 * space. Subscribers receive every envelope; replays and snapshots are scoped
 * to a generation so that stale process output cannot leak into a fresh
 * attachment.
 */

import type { ServerEventEnvelope, SnapshotEnvelope } from "./types.js";

export type EventType =
  | "session_update"
  | "state_change"
  | "permission_request"
  | "permission_resolved"
  | "terminal_output"
  | "terminal_exit"
  | "agent_log"
  | "process_status"
  | "prompt_done"
  | "generation_changed";

interface SessionEvent<T = unknown> {
  sessionId: string;
  sequence: number;
  processGeneration: number;
  timestamp: number;
  type: EventType;
  payload: T;
}

export interface SessionEventEnvelope {
  sessionId: string;
  sequence: number;
  processGeneration: number;
  timestamp: number;
  eventType: EventType;
  payload: unknown;
}

export { SessionEvent };

class SessionBuffer {
  private sequence = 0;
  readonly events: SessionEvent[] = [];

  constructor(
    readonly sessionId: string,
    readonly processGeneration: number,
    private limit: number,
  ) {}

  append<T>(type: EventType, payload: T): SessionEvent<T> {
    this.sequence += 1;
    const ev: SessionEvent<T> = {
      sessionId: this.sessionId,
      sequence: this.sequence,
      processGeneration: this.processGeneration,
      timestamp: Date.now(),
      type,
      payload,
    };
    this.events.push(ev as SessionEvent);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    return ev;
  }

  after(cursor: number): SessionEvent[] {
    return this.events.filter((e) => e.sequence > cursor);
  }

  latest(): number {
    return this.sequence;
  }
}

export class EventBus {
  private buffers = new Map<string, SessionBuffer>();
  private subscribers = new Set<(sessionId: string, envelope: ServerEventEnvelope | SnapshotEnvelope) => void>();

  constructor(private bufferSize = 5000) {}

  subscribe(cb: (sessionId: string, envelope: ServerEventEnvelope | SnapshotEnvelope) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private key(sessionId: string, processGeneration: number): string {
    return `${sessionId}:${processGeneration}`;
  }

  private getBuffer(sessionId: string, processGeneration: number): SessionBuffer {
    const k = this.key(sessionId, processGeneration);
    let buf = this.buffers.get(k);
    if (!buf) {
      buf = new SessionBuffer(sessionId, processGeneration, this.bufferSize);
      this.buffers.set(k, buf);
    }
    return buf;
  }

  emit<T>(sessionId: string, processGeneration: number, type: EventType, payload: T): SessionEvent<T> {
    const buf = this.getBuffer(sessionId, processGeneration);
    const ev = buf.append(type, payload);
    const envelope: ServerEventEnvelope = {
      type: "event",
      sessionId: ev.sessionId,
      sequence: ev.sequence,
      processGeneration: ev.processGeneration,
      timestamp: ev.timestamp,
      eventType: ev.type,
      payload: ev.payload,
    };
    for (const sub of this.subscribers) {
      try {
        sub(sessionId, envelope);
      } catch {
        /* subscriber errors must not break the bus */
      }
    }
    return ev;
  }

  /** Replays events newer than `after` for a session/generation, or undefined if the cursor is too old. */
  replay(sessionId: string, processGeneration: number, after: number): SessionEvent[] | undefined {
    const buf = this.buffers.get(this.key(sessionId, processGeneration));
    if (!buf) return undefined;
    if (buf.events.length === 0) return [];
    const firstSeq = buf.events[0].sequence;
    if (after + 1 < firstSeq) {
      // Cursor is older than the start of the buffer — caller needs a snapshot.
      return undefined;
    }
    return buf.after(after);
  }

  latestSequence(sessionId: string, processGeneration: number): number | undefined {
    const buf = this.buffers.get(this.key(sessionId, processGeneration));
    return buf?.latest();
  }

  snapshot(sessionId: string, processGeneration: number, state: unknown): SnapshotEnvelope {
    const buf = this.buffers.get(this.key(sessionId, processGeneration));
    const events = buf?.events ?? [];
    return {
      type: "snapshot",
      sessionId,
      processGeneration,
      timestamp: Date.now(),
      state,
      events: events.map(toEnvelope),
    };
  }

  /** Wipe all events for a session/generation (used when a process is replaced). */
  reset(sessionId: string, processGeneration: number): void {
    const k = this.key(sessionId, processGeneration);
    // Only reset if the caller is starting a brand-new generation; preserve
    // older generations for replay/snapshots.
    if (this.buffers.has(k)) {
      this.buffers.set(k, new SessionBuffer(sessionId, processGeneration, this.bufferSize));
    }
  }

  /** Prune stale generations for a session, keeping the most recent `maxGenerations`. */
  prune(sessionId: string, keepProcessGeneration: number, maxGenerations = 5): void {
    const keys: string[] = [];
    for (const k of this.buffers.keys()) {
      if (k.startsWith(`${sessionId}:`)) keys.push(k);
    }
    const gens = keys
      .map((k) => Number(k.split(":")[1]))
      .filter((g) => !Number.isNaN(g) && g !== keepProcessGeneration)
      .sort((a, b) => b - a);
    for (const g of gens.slice(maxGenerations)) {
      this.buffers.delete(this.key(sessionId, g));
    }
  }
}

function toEnvelope(ev: SessionEvent): ServerEventEnvelope {
  return {
    type: "event",
    sessionId: ev.sessionId,
    sequence: ev.sequence,
    processGeneration: ev.processGeneration,
    timestamp: ev.timestamp,
    eventType: ev.type,
    payload: ev.payload,
  };
}
