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
  /** Sequence number of the newest event in the generation buffer. */
  latestSequence: number;
  /** Materialized conversation state when available. */
  messages?: Record<string, unknown>;
  timeline?: unknown[];
  toolCalls?: Record<string, unknown>;
  plan?: unknown | null;
  usage?: unknown | null;
}

export class SessionController {
  sessionId: string;
  readonly createdAt: number;
  processGeneration = 0;
  status: SessionStatus = "starting";
  private acp: AcpProcess | null = null;
  private loadingPromise: Promise<void> | null = null;
  private activeOperation: { token: symbol; generation: number; kind: "prompt" | "cancel" | "attach"; name: string } | undefined;
  private activePrompt: { token: symbol; generation: number; process: AcpProcess; promise: Promise<acp.PromptResponse> } | null = null;
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
      activeOperation: this.activeOperation?.name,
      pendingPermissions: [...this.pendingPermissions.values()],
      running: this.isRunning,
      latestSequence: this.eventBus.latestSequence(this.sessionId, this.processGeneration) ?? 0,
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
    this.eventBus.emit(this.sessionId, this.processGeneration, "state_change", { previous, next, activeOperation: this.activeOperation?.name });
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
      // Replace the previous process. Capture the old one, bump the generation,
      // release its resources, and kill it before starting the replacement.
      const oldAcp = this.acp;
      this.acp = null;
      this.processGeneration += 1;
      const gen = this.processGeneration;
      const previousGeneration = gen - 1;
      this.terminalManager.releaseFor(this.sessionId, previousGeneration);
      this.eventBus.reset(this.sessionId, gen);
      this.eventBus.emit(this.sessionId, previousGeneration, "generation_changed", { previousGeneration, processGeneration: gen });
      for (const requestId of this.pendingPermissions.keys()) {
        this.eventBus.emit(this.sessionId, gen, "permission_resolved", { requestId });
      }
      this.pendingPermissions.clear();
      if (oldAcp && !oldAcp.exited) {
        // Terminate the old process without blocking replacement; the
        // generation guards ensure its callbacks cannot affect state.
        oldAcp.terminate().catch((err) => console.error("failed to terminate old acp:", err));
      }

      let acp: AcpProcess | null = null;
      try {
        acp = await factory(this.cwd, gen, {
          onSessionUpdate: (u: acp.SessionNotification) => {
            if (gen !== this.processGeneration) return;
            this.handleSessionUpdate(u);
          },
          onAgentLog: (channel: string, message: string, level: string) => {
            if (gen !== this.processGeneration) return;
            this.handleAgentLog(channel, message, level);
          },
          onPermissionRequest: (requestId: string, toolCall: unknown, options: PermissionRequest["options"]) => {
            if (gen !== this.processGeneration) return;
            this.handlePermissionRequest(requestId, toolCall, options);
          },
          onPermissionResolved: (requestId: string) => {
            if (gen !== this.processGeneration) return;
            this.handlePermissionResolved(requestId);
          },
          onTerminalOutput: (terminalId: string, data: string) => {
            if (gen !== this.processGeneration) return;
            this.handleTerminalOutput(terminalId, data);
          },
          onTerminalExit: (terminalId: string, exitCode: number | null, signal: string | null) => {
            if (gen !== this.processGeneration) return;
            this.handleTerminalExit(terminalId, exitCode, signal);
          },
          onExit: (code: number | null) => {
            if (gen !== this.processGeneration) return;
            this.handleAcpExit(code);
          },
        });

        if (gen !== this.processGeneration) {
          acp.kill();
          throw new Error("process generation changed during start");
        }

        this.acp = acp;
        await init(acp);
        this.transition("loadComplete");
        this.metadata.updatedAt = Date.now();
      } catch (err) {
        acp?.kill();
        if (gen === this.processGeneration && this.status === "loading") {
          this.transition("fail");
        }
        throw err;
      }
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

    const generation = this.processGeneration;
    const token = Symbol("prompt");
    this.activeOperation = { token, generation, kind: "prompt", name: `prompt-${Date.now()}` };
    this.emitStateChange(this.status, this.status);

    const process = this.acp;
    const promise = process.prompt(blocks);
    this.activePrompt = { token, generation, process, promise };

    const isCurrent = () =>
      this.processGeneration === generation &&
      this.acp === process &&
      this.activePrompt?.token === token;

    const isOpCurrent = () =>
      this.activeOperation?.token === token &&
      this.activeOperation?.generation === generation;

    try {
      const result = await promise;
      if (!isCurrent()) {
        throw new Error("stale prompt completion");
      }
      if (this.status === "running" || this.status === "waiting_for_permission" || this.status === "cancelling") {
        this.transition("complete");
      }
      this.eventBus.emit(this.sessionId, generation, "prompt_done", { result });
      this.metadata.updatedAt = Date.now();
      return result;
    } catch (err) {
      if (isCurrent()) {
        if (this.status === "cancelling") {
          this.transition("complete");
        } else if (this.status === "running" || this.status === "waiting_for_permission") {
          this.transition("fail");
        }
      }
      throw err;
    } finally {
      if (this.activePrompt?.token === token) {
        this.activePrompt = null;
      }
      if (isOpCurrent()) {
        this.activeOperation = undefined;
      }
    }
  }

  async cancel(): Promise<void> {
    const t = this.transition("cancel");
    if (!t.ok) throw Object.assign(new Error(t.message), { status: t.status });

    const generation = this.processGeneration;
    const token = Symbol("cancel");
    this.activeOperation = { token, generation, kind: "cancel", name: `cancel-${Date.now()}` };
    this.emitStateChange(this.status, this.status);

    const CANCEL_TIMEOUT_MS = 5000;
    const isOpCurrent = () =>
      this.activeOperation?.token === token &&
      this.activeOperation?.generation === generation;

    try {
      await this.acp?.cancel();

      if (this.activePrompt) {
        await Promise.race([
          this.activePrompt.promise.catch(() => {}),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), CANCEL_TIMEOUT_MS)),
        ]);
      }
    } catch {
      // Cancel did not settle in time. Kill the ACP process and mark the
      // session failed so the next operation triggers a reattach.
      this.transition("fail");
      this.acp?.kill();
    } finally {
      if (isOpCurrent()) {
        this.activeOperation = undefined;
      }
    }
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const req = this.pendingPermissions.get(requestId);
    if (!req) return false;
    const ok = this.acp?.resolvePermission(requestId, optionId) ?? false;
    if (ok) {
      this.pendingPermissions.delete(requestId);
      this.eventBus.emit(this.sessionId, this.processGeneration, "permission_resolved", { requestId, optionId });
      if (this.pendingPermissions.size === 0 && this.status === "waiting_for_permission") {
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
    if (this.status === "idle" && this.activeOperation?.kind === "prompt") {
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
    if (this.pendingPermissions.size === 0 && this.status === "waiting_for_permission") {
      this.transition("resolve");
    }
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
