/**
 * Owns all `SessionController`s, routes REST/WS actions, and coordinates
 * lifecycle transitions across sessions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { AcpProcess } from "./acp-process.js";
import { EventBus } from "./event-bus.js";
import { SessionController, type SessionMetadata, type PermissionRequest } from "./session-controller.js";
import { TerminalManager } from "./terminal-manager.js";

export interface RegistryEvents {
  onEvent: (sessionId: string, envelope: { type: string; [key: string]: unknown }) => void;
}

export class SessionRegistry {
  private controllers = new Map<string, SessionController>();
  private starting = new Map<string, Promise<void>>();
  private permissionOwners = new Map<string, SessionController>();
  readonly eventBus: EventBus;
  readonly terminals: TerminalManager;

  constructor(private ev?: RegistryEvents) {
    this.eventBus = new EventBus();
    this.terminals = new TerminalManager();
    this.eventBus.subscribe((sessionId, envelope) => {
      this.ev?.onEvent(sessionId, envelope as unknown as { type: string; [key: string]: unknown });
    });
  }

  list(): SessionController[] {
    return [...this.controllers.values()];
  }

  has(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  get(sessionId: string): SessionController | undefined {
    return this.controllers.get(sessionId);
  }

  getOrCreate(sessionId: string, cwd: string, metadata?: Partial<SessionMetadata>): SessionController {
    let c = this.controllers.get(sessionId);
    if (c) return c;
    c = new SessionController(sessionId, cwd, this.terminals, this.eventBus, {
      onPermissionOwner: (requestId, controller) => this.permissionOwners.set(requestId, controller),
      onExit: (controller) => {
        for (const [requestId, owner] of this.permissionOwners) {
          if (owner === controller) this.permissionOwners.delete(requestId);
        }
      },
      onStatusChange: () => {},
    }, metadata);
    this.controllers.set(sessionId, c);
    return c;
  }

  /**
   * Idempotent attach: starts a process for this session only when needed.
   * Uses the controller's current sessionId in case it was reassigned during
   * creation.
   */
  async attach(sessionId: string, cwd: string, metadata?: Partial<SessionMetadata>): Promise<void> {
    const c = this.getOrCreate(sessionId, cwd, metadata);

    const existing = this.starting.get(sessionId);
    if (existing) return existing;

    const p = c.attach((dir, gen, cbs) => AcpProcess.start(c.sessionId, dir, gen, this.terminals, cbs));
    this.starting.set(sessionId, p);
    try {
      await p;
      if (c.sessionId !== sessionId) {
        this.controllers.delete(sessionId);
        this.controllers.set(c.sessionId, c);
      }
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /** Create a new session in its own ACP process and keep that process. */
  async create(cwd: string): Promise<{ sessionId: string; cwd: string; modes?: acp.SessionModeState | null }> {
    const placeholder = `new-${Date.now().toString(36)}`;
    const c = this.getOrCreate(placeholder, cwd, {
      title: null,
      alias: null,
    });

    const existing = this.starting.get(placeholder);
    const p =
      existing ??
      c.create((dir, gen, cbs) => AcpProcess.start(placeholder, dir, gen, this.terminals, cbs));
    this.starting.set(placeholder, p);
    try {
      await p;
      const finalId = c.sessionId;
      this.controllers.delete(placeholder);
      this.controllers.set(finalId, c);
      return { sessionId: finalId, cwd, modes: c.modes };
    } finally {
      this.starting.delete(placeholder);
    }
  }

  /** Resolve a permission request by routing to the owning controller. */
  resolvePermission(requestId: string, optionId: string | null): boolean {
    const owner = this.permissionOwners.get(requestId);
    if (!owner) return false;
    const ok = owner.resolvePermission(requestId, optionId);
    if (ok) this.permissionOwners.delete(requestId);
    return ok;
  }

  /** List existing sessions by asking a transient process in the primary cwd. */
  async listRemote(cwd: string, cursor?: string): Promise<acp.ListSessionsResponse> {
    const temp = await AcpProcess.start(
      "__temp__",
      cwd,
      0,
      this.terminals,
      {
        onSessionUpdate: () => {},
        onAgentLog: () => {},
        onPermissionRequest: () => Promise.resolve({ outcome: { outcome: "cancelled" } }) as any,
        onPermissionResolved: () => {},
        onTerminalOutput: () => {},
        onTerminalExit: () => {},
        onExit: () => {},
      },
    );
    try {
      return await temp.listSessions(cursor);
    } finally {
      temp.kill();
    }
  }

  status() {
    return this.list().map((c) => ({
      sessionId: c.sessionId,
      cwd: c.cwd,
      status: c.currentStatus,
      processGeneration: c.processGeneration,
      running: c.isRunning,
    }));
  }

  killAll() {
    for (const c of this.controllers.values()) c.kill();
    this.terminals.killAll();
  }

  close(sessionId: string) {
    this.controllers.get(sessionId)?.close();
  }
}
