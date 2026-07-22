/**
 * Per-session controller: lifecycle, ACP process ownership, event sequencing.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { EventBus } from "./event-bus.js";
import { nextStatus, isActive, isRunning, type SessionStatus } from "./lifecycle.js";
import type { AcpProcess } from "./acp-process.js";
import type { TerminalManager } from "./terminal-manager.js";

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  title: string | null;
  alias: string | null;
  branch: string | null;
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ControllerCallbacks {
  onPermissionOwner: (requestId: string, controller: SessionController) => void;
  onExit: (controller: SessionController, code: number | null) => void;
  onStatusChange: (controller: SessionController, previous: SessionStatus, next: SessionStatus) => void;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface SessionSnapshot {
  sessionId: string;
  processGeneration: number;
  status: SessionStatus;
  title: string | null;
  cwd: string;
  branch: string | null;
  activeOperation?: string;
  pendingPermissions: PermissionRequest[];
  running: boolean;
}

export class SessionController {
  sessionId: string;
  readonly createdAt: number;
  processGeneration = 0;
  status: SessionStatus = "starting";
  private acp: AcpProcess | null = null;
  private loadingPromise: Promise<void> | null = null;
  private activeOperation?: string;
  private pendingPermissions = new Map<string, PermissionRequest>();
  private metadata: SessionMetadata;
  private eventBus: EventBus;
  private terminalManager: TerminalManager;
  private cbs: ControllerCallbacks;
  private sessionModes: acp.SessionModeState | null = null;

  constructor(
    sessionId: string,
    cwd: string,
    terminalManager: TerminalManager,
    eventBus: EventBus,
    cbs: ControllerCallbacks,
    metadata?: Partial<SessionMetadata>,
  ) {
    this.sessionId = sessionId;
    this.eventBus = eventBus;
    this.terminalManager = terminalManager;
    this.cbs = cbs;
    const now = Date.now();
    this.metadata = {
      sessionId,
      cwd,
      title: metadata?.title ?? null,
      alias: metadata?.alias ?? null,
      branch: metadata?.branch ?? null,
      worktree: metadata?.worktree ?? null,
      createdAt: metadata?.createdAt ?? now,
      updatedAt: metadata?.updatedAt ?? now,
    };
    this.createdAt = this.metadata.createdAt;
  }

  get cwd(): string {
    return this.metadata.cwd;
  }

  get title(): string | null {
    return this.metadata.title ?? this.metadata.alias ?? null;
  }

  get alias(): string | null {
    return this.metadata.alias;
  }

  get branch(): string | null {
    return this.metadata.branch;
  }

  get worktree(): string | null {
    return this.metadata.worktree;
  }

  get currentStatus(): SessionStatus {
    return this.status;
  }

  get isActive(): boolean {
    return isActive(this.status);
  }

  get isRunning(): boolean {
    return isRunning(this.status);
  }

  getAcp(): AcpProcess | null {
    return this.acp;
  }

  get acpCapabilities(): acp.InitializeResponse | null {
    return this.acp?.capabilities ?? null;
  }

  get modes(): acp.SessionModeState | null {
    return this.sessionModes;
  }

  setMetadata(patch: Partial<SessionMetadata>) {
    Object.assign(this.metadata, patch);
    this.metadata.updatedAt = Date.now();
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      processGeneration: this.processGeneration,
      status: this.status,
      title: this.title,
      cwd: this.cwd,
      branch: this.branch,
      activeOperation: this.activeOperation,
      pendingPermissions: [...this.pendingPermissions.values()],
      running: this.isRunning,
    };
  }

  private transition(operation: string, next?: SessionStatus): { ok: true } | { ok: false; status: number; message: string } {
    const result = nextStatus(this.status, operation);
    if (!result.ok) return { ok: false, status: result.error.status, message: result.error.message };
    const prev = this.status;
    const nxt = next ?? result.next;
    if (nxt === prev) return { ok: true };
    this.status = nxt;
    this.cbs.onStatusChange(this, prev, nxt);
    this.emitStateChange(prev, nxt);
    return { ok: true };
  }

  private emitStateChange(previous: SessionStatus, next: SessionStatus) {
    this.eventBus.emit(this.sessionId, this.processGeneration, "state_change", { previous, next, activeOperation: this.activeOperation });
  }

  /** Idempotent attach for an existing session (load or resume). */
  async attach(factory: (cwd: string, generation: number, cbs: any) => Promise<AcpProcess>): Promise<void> {
    return this.start("attach", factory, async (acp) => {
      const supportsResume = !!acp.capabilities?.agentCapabilities?.sessionCapabilities?.resume;
      if (supportsResume) {
        await acp.resumeSession(this.sessionId, this.cwd);
      } else {
        await acp.loadSession(this.sessionId, this.cwd);
      }
    });
  }

  /** Create a brand-new session in a fresh ACP process. */
  async create(factory: (cwd: string, generation: number, cbs: any) => Promise<AcpProcess>): Promise<void> {
    return this.start("attach", factory, async (acp) => {
      const res = await acp.newSession(this.cwd);
      this.sessionModes = res.modes ?? null;
      // The agent assigned a sessionId. If it differs from what the caller
      // expected, trust the agent and update our identity.
      if (res.sessionId !== this.sessionId) {
        this.sessionId = res.sessionId;
        this.metadata.sessionId = res.sessionId;
        acp.setSessionId(res.sessionId);
      }
    });
  }

  private async start(
    operation: string,
    factory: (cwd: string, generation: number, cbs: any) => Promise<AcpProcess>,
    init: (acp: AcpProcess) => Promise<void>,
  ): Promise<void> {
    if (this.acp && !this.acp.exited && (this.status === "idle" || this.status === "running" || this.status === "waiting_for_permission")) {
      return;
    }
    if (this.loadingPromise) return this.loadingPromise;

    const t = this.transition(operation);
    if (!t.ok) {
      throw Object.assign(new Error(t.message), { status: t.status });
    }

    this.loadingPromise = (async () => {
      if (this.acp?.exited || !this.acp) {
        this.processGeneration += 1;
        this.terminalManager.releaseFor(this.sessionId, this.processGeneration - 1);
        this.eventBus.reset(this.sessionId, this.processGeneration);
      }

      const gen = this.processGeneration;
      const acp = await factory(this.cwd, gen, {
        onSessionUpdate: (u: acp.SessionNotification) => this.handleSessionUpdate(u),
        onAgentLog: (channel: string, message: string, level: string) => this.handleAgentLog(channel, message, level),
        onPermissionRequest: (requestId: string, toolCall: unknown, options: PermissionRequest["options"]) =>
          this.handlePermissionRequest(requestId, toolCall, options),
        onPermissionResolved: (requestId: string) => this.handlePermissionResolved(requestId),
        onTerminalOutput: (terminalId: string, data: string) => this.handleTerminalOutput(terminalId, data),
        onTerminalExit: (terminalId: string, exitCode: number | null, signal: string | null) =>
          this.handleTerminalExit(terminalId, exitCode, signal),
        onExit: (code: number | null) => this.handleAcpExit(code),
      });

      if (gen !== this.processGeneration) {
        acp.kill();
        throw new Error("process generation changed during start");
      }

      this.acp = acp;

      try {
        await init(acp);
      } catch (err) {
        acp.kill();
        this.transition("fail");
        throw err;
      }

      this.transition("loadComplete");
      this.metadata.updatedAt = Date.now();
    })();

    try {
      await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const t = this.transition("prompt");
    if (!t.ok) throw Object.assign(new Error(t.message), { status: t.status });

    if (!this.acp || this.acp.exited) {
      this.transition("fail");
      throw new Error("session process unavailable");
    }

    this.activeOperation = `prompt-${Date.now()}`;
    this.emitStateChange(this.status, this.status);

    try {
      const result = await this.acp.prompt(blocks);
      if (this.status === "running" || this.status === "waiting_for_permission" || this.status === "cancelling") {
        this.transition("complete");
      }
      this.eventBus.emit(this.sessionId, this.processGeneration, "prompt_done", { result });
      this.activeOperation = undefined;
      this.metadata.updatedAt = Date.now();
      return result;
    } catch (err) {
      if (this.status === "running" || this.status === "waiting_for_permission" || this.status === "cancelling") {
        this.transition("fail");
      }
      this.activeOperation = undefined;
      throw err;
    }
  }

  async cancel(): Promise<void> {
    const t = this.transition("cancel");
    if (!t.ok) throw Object.assign(new Error(t.message), { status: t.status });

    this.activeOperation = `cancel-${Date.now()}`;
    this.emitStateChange(this.status, this.status);

    try {
      await this.acp?.cancel();
      // The final transition to idle happens when the prompt completes or the
      // process exit handler fires. Do not eagerly mark idle here.
    } catch {
      // cancel is best-effort; idempotent on the client side.
    } finally {
      this.activeOperation = undefined;
    }
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const req = this.pendingPermissions.get(requestId);
    if (!req) return false;
    const ok = this.acp?.resolvePermission(requestId, optionId) ?? false;
    if (ok) {
      this.pendingPermissions.delete(requestId);
      this.eventBus.emit(this.sessionId, this.processGeneration, "permission_resolved", { requestId, optionId });
      if (this.status === "waiting_for_permission") {
        this.transition("resolve");
      }
    }
    return ok;
  }

  async setConfig(configId: string, value: string): Promise<unknown> {
    if (!this.acp || this.acp.exited) throw new Error("session process unavailable");
    return this.acp.setConfigOption(configId, value);
  }

  async rename(title: string): Promise<boolean> {
    if (!this.acp || this.acp.exited) throw new Error("session process unavailable");
    const ok = await this.acp.renameSession(title);
    if (ok || !ok) {
      // Local alias is authoritative; update regardless.
      this.metadata.alias = title || null;
      this.metadata.updatedAt = Date.now();
    }
    return ok;
  }

  close(): void {
    if (this.status === "closed") return;
    this.transition("close");
    this.acp?.kill();
    this.acp = null;
  }

  kill(): void {
    this.acp?.kill();
  }

  // ---- handlers ----------------------------------------------------------------

  private handleSessionUpdate(update: acp.SessionNotification) {
    // Reflect running state when the agent sends non-final updates.
    if (this.status === "idle" && this.activeOperation?.startsWith("prompt-")) {
      this.transition("prompt");
    }
    this.eventBus.emit(this.sessionId, this.processGeneration, "session_update", update);
    this.metadata.updatedAt = Date.now();
  }

  private handleAgentLog(channel: string, message: string, level: string) {
    this.eventBus.emit(this.sessionId, this.processGeneration, "agent_log", { channel, message, level });
  }

  private handlePermissionRequest(requestId: string, toolCall: unknown, options: PermissionRequest["options"]) {
    if (this.status === "running") {
      this.transition("permission");
    }
    const req: PermissionRequest = { requestId, sessionId: this.sessionId, toolCall, options };
    this.pendingPermissions.set(requestId, req);
    this.cbs.onPermissionOwner(requestId, this);
    this.eventBus.emit(this.sessionId, this.processGeneration, "permission_request", req);
  }

  private handlePermissionResolved(requestId: string) {
    this.pendingPermissions.delete(requestId);
    this.eventBus.emit(this.sessionId, this.processGeneration, "permission_resolved", { requestId });
  }

  private handleTerminalOutput(terminalId: string, data: string) {
    this.eventBus.emit(this.sessionId, this.processGeneration, "terminal_output", { terminalId, data });
  }

  private handleTerminalExit(terminalId: string, exitCode: number | null, signal: string | null) {
    this.eventBus.emit(this.sessionId, this.processGeneration, "terminal_exit", { terminalId, exitCode, signal });
  }

  private handleAcpExit(code: number | null) {
    if (this.status === "closed") return;
    this.transition("fail");
    this.eventBus.emit(this.sessionId, this.processGeneration, "process_status", { status: "exited", code });
    this.cbs.onExit(this, code);
  }
}
