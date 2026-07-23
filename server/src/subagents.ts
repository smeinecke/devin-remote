/**
 * Normalized subagent state derived from Cognition-specific ACP `_meta`
 * annotations on tool calls.
 *
 * The Devin CLI represents subagents as ordinary `tool_call` / `tool_call_update`
 * messages with `_meta["cognition.ai/subagent_started"]` and
 * `_meta["cognition.ai/subagent_completed"]` objects. Child tools executed by a
 * subagent carry `_meta["cognition.ai/subagent_context"]` with the parent
 * `agentId`. This registry turns those vendor-specific shapes into stable,
 * normalized lifecycle events.
 *
 * Spawn correlation: the protocol does not include an explicit parent tool-call
 * id in the `subagent_started` event, so pending `run_subagent` tool calls are
 * queued and matched FIFO by the strongest available metadata
 * (task / title / profile / parent agent id). Pending entries expire after a TTL
 * and are bounded to prevent unbounded memory growth.
 */

import type { SubagentDescriptor } from "./types.js";

export type { SubagentDescriptor } from "./types.js";

export type NormalizedSubagentEvent =
  | {
      type: "subagent_started";
      subagent: SubagentDescriptor;
    }
  | {
      type: "subagent_updated";
      subagentId: string;
      patch: Partial<SubagentDescriptor>;
    }
  | {
      type: "subagent_completed";
      subagentId: string;
      result: string | null;
      completedAt: number;
    }
  | {
      type: "subagent_failed";
      subagentId: string;
      error: string;
      completedAt: number;
      status: "failed" | "cancelled";
    }
  | {
      type: "subagent_cancelled";
      subagentId: string;
      completedAt: number;
    };

const TERMINAL_SUBAGENT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

interface PendingSubagentSpawn {
  toolCallId: string;
  parentSubagentId: string | null;
  parentAgentId: string | null;
  task: string | null;
  title: string | null;
  profile: string | null;
  isBackground: boolean;
  createdAt: number;
  key: string;
}

const MAX_PENDING_SPAWNS = 100;
const SPAWN_CORRELATION_TTL_MS = 60_000;

function normalizeTask(task: string | null): string {
  return (task ?? "").trim().replace(/\s+/g, " ");
}

function normalizeProfile(profile: string | null): string {
  const p = (profile ?? "").trim().toLowerCase();
  return p.replace(/^subagent_/, "");
}

function makeKey(
  parentAgentId: string | null,
  task: string | null,
  title: string | null,
  profile: string | null,
): string {
  return [
    parentAgentId ?? "",
    normalizeTask(task),
    (title ?? "").trim(),
    normalizeProfile(profile),
  ].join("\0");
}

function getMeta(update: Record<string, unknown>, key: string): unknown {
  const meta = update._meta as Record<string, unknown> | undefined;
  return meta?.[key];
}

function extractText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const typed = item as Record<string, unknown>;
      const inner = typed.content as Record<string, unknown> | undefined;
      const text =
        typeof inner?.text === "string"
          ? inner.text
          : typeof typed.text === "string"
            ? typed.text
            : null;
      if (text) texts.push(text);
    }
  }
  return texts.length ? texts.join("\n") : null;
}

function isRunSubagent(update: Record<string, unknown>): boolean {
  const inferenceToolName = getMeta(update, "cognition.ai/inferenceToolName");
  if (inferenceToolName === "run_subagent") return true;
  const rawInput = update.rawInput as Record<string, unknown> | undefined;
  return (
    typeof rawInput?.task === "string" &&
    typeof rawInput?.profile === "string" &&
    (rawInput?.is_background === true || rawInput?.is_background === false)
  );
}

function isTerminalStatus(status: string): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status as any);
}

function debug(...args: unknown[]) {
  if (process.env.DEBUG?.includes("subagent") || process.env.DEBUG_SUBAGENTS === "1") {
    console.log("[subagents]", ...args);
  }
}

export class SubagentRegistry {
  private subagents = new Map<string, SubagentDescriptor>();
  private pending: PendingSubagentSpawn[] = [];
  private pendingByToolCallId = new Map<string, PendingSubagentSpawn>();
  private pendingByKey = new Map<string, PendingSubagentSpawn[]>();

  constructor(
    private sessionId: string,
    private processGeneration: number,
  ) {}

  get(id: string): SubagentDescriptor | undefined {
    return this.subagents.get(id);
  }

  list(): SubagentDescriptor[] {
    return [...this.subagents.values()];
  }

  snapshot(): Record<string, SubagentDescriptor> {
    const out: Record<string, SubagentDescriptor> = {};
    for (const [id, s] of this.subagents) out[id] = s;
    return out;
  }

  /** Mark every non-terminal subagent as failed (ACP process exited). */
  onProcessExit(completedAt = Date.now()): NormalizedSubagentEvent[] {
    const events: NormalizedSubagentEvent[] = [];
    for (const s of this.subagents.values()) {
      if (!isTerminalStatus(s.status)) {
        s.completedAt = completedAt;
        s.error = s.error ?? "process exited";
        s.status = "failed";
        events.push({
          type: "subagent_failed",
          subagentId: s.id,
          error: s.error,
          completedAt,
          status: "failed",
        });
      }
    }
    return events;
  }

  /** Call when a permission request is known to belong to a subagent. */
  addPendingPermission(
    subagentId: string,
    requestId: string,
  ): NormalizedSubagentEvent | null {
    const isNew = !this.subagents.has(subagentId);
    const s = this.ensureSubagent(subagentId, {
      status: "waiting_for_permission",
      pendingPermissions: [],
    });

    const hadPermission = s.pendingPermissions.includes(requestId);
    if (!hadPermission) {
      s.pendingPermissions = [...s.pendingPermissions, requestId];
    }

    const previousStatus = s.status;
    if (!isTerminalStatus(s.status) && s.status !== "waiting_for_permission") {
      s.status = "waiting_for_permission";
    }

    const changed = !hadPermission || s.status !== previousStatus;
    if (!changed) return null;

    this.subagents.set(subagentId, s);
    debug("permission attributed", { requestId, subagentId: subagentId.slice(0, 8) });
    if (isNew) {
      return { type: "subagent_started", subagent: s };
    }
    return {
      type: "subagent_updated",
      subagentId,
      patch: { pendingPermissions: s.pendingPermissions, status: s.status },
    };
  }

  resolvePermission(
    subagentId: string,
    requestId: string,
  ): NormalizedSubagentEvent | null {
    const s = this.subagents.get(subagentId);
    if (!s) return null;

    const previousPending = s.pendingPermissions;
    const nextPending = previousPending.filter((id) => id !== requestId);
    if (nextPending.length === previousPending.length) {
      // Idempotent: request was not in this subagent's set.
      return null;
    }

    s.pendingPermissions = nextPending;

    const previousStatus = s.status;
    if (
      s.pendingPermissions.length === 0 &&
      s.status === "waiting_for_permission" &&
      !isTerminalStatus(s.status)
    ) {
      s.status = "running";
    }

    debug("permission resolved", { requestId, subagentId: subagentId.slice(0, 8), remaining: s.pendingPermissions.length });
    return {
      type: "subagent_updated",
      subagentId,
      patch: { pendingPermissions: s.pendingPermissions, status: s.status },
    };
  }

  /**
   * Process a raw ACP `session_update` payload.
   * Returns a normalized subagent event, or null when no subagent state changed.
   */
  processUpdate(update: Record<string, unknown>): NormalizedSubagentEvent | null {
    const type = update.sessionUpdate as string | undefined;
    if (!type) return null;

    this.expirePending();

    if (type === "tool_call") {
      return this.processToolCall(update);
    }

    if (type === "tool_call_update") {
      return this.processToolCallUpdate(update);
    }

    return null;
  }

  private processToolCall(update: Record<string, unknown>): NormalizedSubagentEvent | null {
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return null;

    const subagentContext = getMeta(update, "cognition.ai/subagent_context") as
      | { parentAgentId?: string }
      | undefined;
    const parentAgentId = subagentContext?.parentAgentId ?? null;

    if (isRunSubagent(update)) {
      const rawInput = update.rawInput as Record<string, unknown> | undefined;
      const task = typeof rawInput?.task === "string" ? rawInput.task : null;
      const title = typeof rawInput?.title === "string" ? rawInput.title : null;
      const profile = typeof rawInput?.profile === "string" ? rawInput.profile : null;
      const isBackground = rawInput?.is_background === true;
      const key = makeKey(parentAgentId, task, title, profile);
      const entry: PendingSubagentSpawn = {
        toolCallId,
        parentSubagentId: parentAgentId,
        parentAgentId,
        task,
        title,
        profile,
        isBackground,
        createdAt: Date.now(),
        key,
      };
      this.pending.push(entry);
      this.pendingByToolCallId.set(toolCallId, entry);
      const arr = this.pendingByKey.get(key) ?? [];
      arr.push(entry);
      this.pendingByKey.set(key, arr);
      debug("pending spawn registered", {
        toolCallId: toolCallId.slice(0, 8),
        task: task?.slice(0, 60) ?? null,
        title: title ?? null,
        profile: profile ?? null,
      });
      this.expirePending();
      return null;
    }

    if (parentAgentId) {
      const isNew = !this.subagents.has(parentAgentId);
      const s = this.ensureSubagent(parentAgentId, {});
      const nextToolCallIds = this.addToolCallId(s.toolCallIds, toolCallId);
      if (nextToolCallIds.length === s.toolCallIds.length && !isNew) return null;
      s.toolCallIds = nextToolCallIds;
      this.subagents.set(parentAgentId, s);
      if (isNew) {
        return { type: "subagent_started", subagent: s };
      }
      return { type: "subagent_updated", subagentId: parentAgentId, patch: { toolCallIds: s.toolCallIds } };
    }

    return null;
  }

  private processToolCallUpdate(update: Record<string, unknown>): NormalizedSubagentEvent | null {
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return null;

    const status = String(update.status ?? "").toLowerCase();

    const started = getMeta(update, "cognition.ai/subagent_started") as
      | {
          agentId?: string;
          title?: string;
          task?: string;
          profile?: string;
          depth?: number;
          isBackground?: boolean;
          parentAgentId?: string;
        }
      | undefined;

    if (started?.agentId) {
      return this.handleSubagentStarted(toolCallId, started);
    }

    const completed = getMeta(update, "cognition.ai/subagent_completed") as
      | { agentId?: string; success?: boolean; summary?: string; depth?: number }
      | undefined;
    if (completed?.agentId) {
      return this.handleSubagentCompleted(completed.agentId, {
        success: completed.success,
        summary: completed.summary,
      });
    }

    const subagentContext = getMeta(update, "cognition.ai/subagent_context") as
      | { parentAgentId?: string }
      | undefined;
    const parentAgentId = subagentContext?.parentAgentId;
    if (parentAgentId) {
      const isNew = !this.subagents.has(parentAgentId);
      const s = this.ensureSubagent(parentAgentId, {});
      const nextToolCallIds = this.addToolCallId(s.toolCallIds, toolCallId);
      if (nextToolCallIds.length === s.toolCallIds.length && !isNew) return null;
      s.toolCallIds = nextToolCallIds;
      this.subagents.set(parentAgentId, s);
      if (isNew) {
        return { type: "subagent_started", subagent: s };
      }
      return { type: "subagent_updated", subagentId: parentAgentId, patch: { toolCallIds: s.toolCallIds } };
    }

    const inferenceToolName = getMeta(update, "cognition.ai/inferenceToolName");
    if (inferenceToolName === "run_subagent") {
      // The spawning tool failed or was cancelled before the subagent started.
      if (status === "failed" || status === "cancelled" || status === "error") {
        const entry = this.pendingByToolCallId.get(toolCallId);
        if (entry) {
          this.removePending(entry);
          debug("pending spawn removed (tool failed/cancelled)", { toolCallId: toolCallId.slice(0, 8), status });
        }
        return null;
      }
    }

    if (inferenceToolName === "read_subagent" && status === "completed") {
      const rawInput = update.rawInput as Record<string, unknown> | undefined;
      const agentId = typeof rawInput?.agent_id === "string" ? rawInput.agent_id : null;
      const text = extractText(update.content);
      if (agentId && text) {
        return this.handleReadSubagentFallback(agentId, text);
      }
    }

    return null;
  }

  private handleSubagentStarted(
    toolCallId: string,
    started: {
      agentId?: string;
      title?: string;
      task?: string;
      profile?: string;
      depth?: number;
      isBackground?: boolean;
      parentAgentId?: string;
    },
  ): NormalizedSubagentEvent | null {
    const agentId = started.agentId!;
    const existing = this.subagents.get(agentId);
    const now = Date.now();

    const pending = this.matchPendingSpawn(
      started.parentAgentId ?? null,
      started.task ?? null,
      started.title ?? null,
      started.profile ?? null,
    );

    const title =
      started.title ??
      pending?.title ??
      existing?.title ??
      `Subagent ${agentId.slice(0, 8)}`;
    const prompt =
      started.task ?? pending?.task ?? existing?.prompt ?? null;
    const profile =
      started.profile ?? pending?.profile ?? existing?.profile ?? null;
    const depth = started.depth ?? existing?.depth ?? 1;
    const isBackground =
      started.isBackground ?? pending?.isBackground ?? existing?.isBackground ?? true;

    const previousToolCallIds = existing?.toolCallIds ?? [];
    const toolCallIds = this.addToolCallId(previousToolCallIds, toolCallId);

    let status: SubagentDescriptor["status"] = "running";
    if (existing) {
      if (isTerminalStatus(existing.status)) {
        status = existing.status;
      } else if (existing.status === "starting") {
        status = "running";
      } else {
        status = existing.status;
      }
    }
    const startedAt = existing?.startedAt ?? now;

    const descriptor: SubagentDescriptor = {
      id: agentId,
      sessionId: this.sessionId,
      processGeneration: this.processGeneration,
      parentSubagentId:
        existing?.parentSubagentId ?? pending?.parentSubagentId ?? null,
      parentToolCallId:
        existing?.parentToolCallId ?? pending?.toolCallId ?? null,
      title,
      prompt,
      status,
      startedAt,
      completedAt: existing?.completedAt ?? null,
      result: existing?.result ?? null,
      error: existing?.error ?? null,
      profile,
      depth,
      isBackground,
      toolCallIds,
      pendingPermissions: existing?.pendingPermissions ?? [],
    };

    // Detect actual changes to avoid re-emitting duplicate start events.
    const changed =
      !existing ||
      existing.title !== descriptor.title ||
      existing.prompt !== descriptor.prompt ||
      existing.status !== descriptor.status ||
      existing.parentSubagentId !== descriptor.parentSubagentId ||
      existing.parentToolCallId !== descriptor.parentToolCallId ||
      existing.profile !== descriptor.profile ||
      existing.depth !== descriptor.depth ||
      existing.isBackground !== descriptor.isBackground ||
      toolCallIds.length !== previousToolCallIds.length;

    if (!changed) {
      debug("ignored duplicate start", { agentId: agentId.slice(0, 8) });
      return null;
    }

    this.subagents.set(agentId, descriptor);
    debug("subagent started/updated", {
      agentId: agentId.slice(0, 8),
      status: descriptor.status,
      matchedSpawn: pending?.toolCallId.slice(0, 8) ?? null,
    });

    if (!existing) {
      return { type: "subagent_started", subagent: descriptor };
    }
    const patch: Partial<SubagentDescriptor> = {
      title,
      prompt,
      profile,
      depth,
      isBackground,
      parentSubagentId: descriptor.parentSubagentId,
      parentToolCallId: descriptor.parentToolCallId,
      toolCallIds,
    };
    if (descriptor.status !== existing.status) {
      patch.status = descriptor.status;
    }
    return { type: "subagent_updated", subagentId: agentId, patch };
  }

  private handleSubagentCompleted(
    agentId: string,
    outcome: { success?: boolean; summary?: string },
  ): NormalizedSubagentEvent | null {
    const s = this.subagents.get(agentId);
    if (!s) {
      // Completion for a subagent we never saw start — create a minimal record.
      const now = Date.now();
      const status = outcome.success === false ? "failed" : "completed";
      const descriptor: SubagentDescriptor = {
        id: agentId,
        sessionId: this.sessionId,
        processGeneration: this.processGeneration,
        parentSubagentId: null,
        parentToolCallId: null,
        title: `Subagent ${agentId.slice(0, 8)}`,
        prompt: null,
        status,
        startedAt: null,
        completedAt: now,
        result: outcome.success !== false ? (outcome.summary ?? null) : null,
        error: outcome.success === false ? (outcome.summary ?? null) : null,
        profile: null,
        depth: 1,
        isBackground: true,
        toolCallIds: [],
        pendingPermissions: [],
      };
      this.subagents.set(agentId, descriptor);
      if (status === "completed") {
        return { type: "subagent_completed", subagentId: agentId, result: descriptor.result, completedAt: now };
      }
      return {
        type: "subagent_failed",
        subagentId: agentId,
        error: descriptor.error ?? "",
        completedAt: now,
        status: "failed",
      };
    }

    const previousStatus = s.status;
    const now = Date.now();
    const completedAt = s.completedAt ?? now;
    const summary = outcome.summary ?? null;

    let status: SubagentDescriptor["status"] = s.status;
    if (!isTerminalStatus(s.status) || s.status === "waiting_for_permission") {
      if (outcome.success) {
        status = "completed";
      } else {
        const lower = (summary ?? "").toLowerCase();
        status = lower.includes("cancel") || lower.includes("cancelled") ? "cancelled" : "failed";
      }
    }

    // Do not overwrite authoritative result / error / completion timestamps.
    if (outcome.success) {
      if (summary && !s.result) s.result = summary;
    } else {
      if (summary && !s.error) s.error = summary;
      if (summary && !s.result) s.result = summary;
    }
    s.completedAt = completedAt;
    s.status = status;

    this.subagents.set(agentId, s);

    const changed = previousStatus !== s.status || s.completedAt !== completedAt;
    if (!changed && s.result === summary && s.error === summary) {
      debug("ignored duplicate completion", { agentId: agentId.slice(0, 8), status });
      return null;
    }

    debug("subagent completed", { agentId: agentId.slice(0, 8), status, success: outcome.success });

    if (s.status === "completed") {
      return { type: "subagent_completed", subagentId: agentId, result: s.result, completedAt: s.completedAt };
    }
    if (s.status === "cancelled") {
      return { type: "subagent_cancelled", subagentId: agentId, completedAt: s.completedAt };
    }
    return {
      type: "subagent_failed",
      subagentId: agentId,
      error: s.error ?? s.result ?? "",
      completedAt: s.completedAt,
      status: "failed",
    };
  }

  private handleReadSubagentFallback(agentId: string, text: string): NormalizedSubagentEvent | null {
    const s = this.subagents.get(agentId);
    const now = Date.now();
    if (!s) {
      const descriptor: SubagentDescriptor = {
        id: agentId,
        sessionId: this.sessionId,
        processGeneration: this.processGeneration,
        parentSubagentId: null,
        parentToolCallId: null,
        title: `Subagent ${agentId.slice(0, 8)}`,
        prompt: null,
        status: "completed",
        startedAt: null,
        completedAt: now,
        result: text,
        error: null,
        profile: null,
        depth: 1,
        isBackground: true,
        toolCallIds: [],
        pendingPermissions: [],
      };
      this.subagents.set(agentId, descriptor);
      return { type: "subagent_completed", subagentId: agentId, result: text, completedAt: now };
    }

    if (isTerminalStatus(s.status)) {
      if (text && !s.result) {
        s.result = text;
        this.subagents.set(agentId, s);
        return { type: "subagent_completed", subagentId: agentId, result: s.result, completedAt: s.completedAt ?? now };
      }
      return null;
    }

    s.completedAt = s.completedAt ?? now;
    s.status = "completed";
    if (text && !s.result) s.result = text;
    this.subagents.set(agentId, s);
    return { type: "subagent_completed", subagentId: agentId, result: s.result, completedAt: s.completedAt };
  }

  private matchPendingSpawn(
    parentAgentId: string | null,
    task: string | null,
    title: string | null,
    profile: string | null,
  ): PendingSubagentSpawn | undefined {
    this.expirePending();

    // If the start event carried a parent agent id, prefer an exact keyed match.
    if (parentAgentId) {
      const fullKey = makeKey(parentAgentId, task, title, profile);
      const arr = this.pendingByKey.get(fullKey);
      if (arr && arr.length > 0) {
        const entry = arr[0];
        this.removePending(entry);
        debug("spawn matched (keyed)", {
          agentId: null,
          spawn: entry.toolCallId.slice(0, 8),
          task: task?.slice(0, 60) ?? null,
        });
        return entry;
      }
    }

    // Fallback: FIFO over all pending spawns with matching task/title/profile.
    const partialKey = makeKey(null, task, title, profile);
    for (const p of this.pending) {
      if (makeKey(null, p.task, p.title, p.profile) === partialKey) {
        this.removePending(p);
        debug("spawn matched (FIFO)", {
          spawn: p.toolCallId.slice(0, 8),
          task: task?.slice(0, 60) ?? null,
        });
        return p;
      }
    }

    debug("spawn unmatched", { task: task?.slice(0, 60) ?? null, title: title ?? null, profile: profile ?? null });
    return undefined;
  }

  private expirePending(): void {
    const now = Date.now();
    let removed = 0;
    while (this.pending.length > 0) {
      const first = this.pending[0];
      if (now - first.createdAt > SPAWN_CORRELATION_TTL_MS) {
        this.removePending(first);
        removed++;
      } else {
        break;
      }
    }
    while (this.pending.length > MAX_PENDING_SPAWNS) {
      this.removePending(this.pending[0]);
      removed++;
    }
    if (removed > 0) {
      debug("pending spawns expired", { removed, remaining: this.pending.length });
    }
  }

  private removePending(entry: PendingSubagentSpawn): void {
    const idx = this.pending.indexOf(entry);
    if (idx >= 0) this.pending.splice(idx, 1);
    this.pendingByToolCallId.delete(entry.toolCallId);
    const arr = this.pendingByKey.get(entry.key);
    if (arr) {
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.pendingByKey.delete(entry.key);
    }
  }

  private ensureSubagent(
    id: string,
    defaults: Partial<SubagentDescriptor>,
  ): SubagentDescriptor {
    const existing = this.subagents.get(id);
    if (existing) {
      return existing;
    }
    const now = Date.now();
    const descriptor: SubagentDescriptor = {
      id,
      sessionId: this.sessionId,
      processGeneration: this.processGeneration,
      parentSubagentId: defaults.parentSubagentId ?? null,
      parentToolCallId: defaults.parentToolCallId ?? null,
      title: defaults.title ?? `Subagent ${id.slice(0, 8)}`,
      prompt: defaults.prompt ?? null,
      status: (defaults.status as SubagentDescriptor["status"]) ?? "unknown",
      startedAt: defaults.startedAt ?? null,
      completedAt: defaults.completedAt ?? null,
      result: defaults.result ?? null,
      error: defaults.error ?? null,
      profile: defaults.profile ?? null,
      depth: defaults.depth ?? 1,
      isBackground: defaults.isBackground ?? true,
      toolCallIds: defaults.toolCallIds ?? [],
      pendingPermissions: defaults.pendingPermissions ?? [],
    };
    this.subagents.set(id, descriptor);
    return descriptor;
  }

  private addToolCallId(toolCallIds: string[], toolCallId: string): string[] {
    if (toolCallIds.includes(toolCallId)) return toolCallIds;
    return [...toolCallIds, toolCallId];
  }
}
