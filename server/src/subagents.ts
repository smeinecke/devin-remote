/**
 * Normalized subagent state derived from Cognition-specific ACP `_meta`
 * annotations on tool calls.
 *
 * The Devin CLI represents subagents as ordinary `tool_call` / `tool_call_update`
 * messages with `_meta["cognition.ai/subagent_started"]` and
 * `_meta["cognition.ai/subagent_completed"]` objects. Child tools executed by a
 * subagent carry `_meta["cognition.ai/subagent_context"]` with the parent
 * `agentId`. This registry turns those vendor-specific shapes into a stable
 * `SubagentDescriptor` that is forwarded to the frontend as `subagent_update`
 * events.
 */

export type SubagentStatus =
  | "starting"
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SubagentDescriptor {
  id: string;
  sessionId: string;
  processGeneration: number;

  parentSubagentId: string | null;
  parentToolCallId: string | null;

  title: string | null;
  prompt: string | null;
  status: SubagentStatus;

  startedAt: number | null;
  completedAt: number | null;

  result: string | null;
  error: string | null;

  /** Subagent profile name, e.g. "Explore" or "subagent_general". */
  profile: string | null;
  depth: number;
  isBackground: boolean;

  /** Tool-call ids executed by this subagent. */
  toolCallIds: string[];
  /** Permission request ids currently pending for this subagent. */
  pendingPermissions: string[];
}

interface PendingSubagentCall {
  toolCallId: string;
  title: string | null;
  task: string | null;
  profile: string | null;
  isBackground: boolean;
  parentSubagentId: string | null;
  ts: number;
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
      const text = typeof inner?.text === "string" ? inner.text : typeof typed.text === "string" ? typed.text : null;
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

export class SubagentRegistry {
  private subagents = new Map<string, SubagentDescriptor>();
  private pendingCalls: PendingSubagentCall[] = [];

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

  /** Call when a permission request is known to belong to a subagent. */
  addPendingPermission(subagentId: string, requestId: string): SubagentDescriptor | null {
    const s = this.subagents.get(subagentId);
    if (!s) return null;
    if (!s.pendingPermissions.includes(requestId)) s.pendingPermissions.push(requestId);
    if (s.status === "running" || s.status === "starting") s.status = "waiting_for_permission";
    return s;
  }

  resolvePermission(subagentId: string, requestId: string): SubagentDescriptor | null {
    const s = this.subagents.get(subagentId);
    if (!s) return null;
    s.pendingPermissions = s.pendingPermissions.filter((id) => id !== requestId);
    if (s.status === "waiting_for_permission" && s.pendingPermissions.length === 0) {
      s.status = "running";
    }
    return s;
  }

  /**
   * Process a raw ACP `session_update` payload.
   * Returns the changed subagent descriptor, or null when no subagent state
   * changed.
   */
  processUpdate(update: Record<string, unknown>): SubagentDescriptor | null {
    const type = update.sessionUpdate as string | undefined;
    if (!type) return null;

    if (type === "tool_call") {
      return this.processToolCall(update);
    }

    if (type === "tool_call_update") {
      return this.processToolCallUpdate(update);
    }

    return null;
  }

  private processToolCall(update: Record<string, unknown>): SubagentDescriptor | null {
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return null;

    const subagentContext = getMeta(update, "cognition.ai/subagent_context") as
      | { parentAgentId?: string }
      | undefined;
    const parentAgentId = subagentContext?.parentAgentId;

    if (isRunSubagent(update)) {
      const rawInput = update.rawInput as Record<string, unknown> | undefined;
      this.pendingCalls.push({
        toolCallId,
        title: typeof rawInput?.title === "string" ? rawInput.title : null,
        task: typeof rawInput?.task === "string" ? rawInput.task : null,
        profile: typeof rawInput?.profile === "string" ? rawInput.profile : null,
        isBackground: rawInput?.is_background === true,
        parentSubagentId: parentAgentId ?? null,
        ts: Date.now(),
      });
      return null;
    }

    if (parentAgentId) {
      const s = this.subagents.get(parentAgentId);
      if (s && !s.toolCallIds.includes(toolCallId)) {
        s.toolCallIds.push(toolCallId);
        return s;
      }
    }

    return null;
  }

  private processToolCallUpdate(update: Record<string, unknown>): SubagentDescriptor | null {
    const toolCallId = String(update.toolCallId ?? "");
    if (!toolCallId) return null;

    const started = getMeta(update, "cognition.ai/subagent_started") as
      | {
          agentId?: string;
          title?: string;
          task?: string;
          profile?: string;
          depth?: number;
          isBackground?: boolean;
        }
      | undefined;
    if (started?.agentId) {
      const pending = this.matchPendingCall(started.title ?? null, started.task ?? null);
      const now = Date.now();
      const existing = this.subagents.get(started.agentId);
      const descriptor: SubagentDescriptor = {
        id: started.agentId,
        sessionId: this.sessionId,
        processGeneration: this.processGeneration,
        parentSubagentId: pending?.parentSubagentId ?? null,
        parentToolCallId: pending?.toolCallId ?? null,
        title: started.title ?? pending?.title ?? `Subagent ${started.agentId.slice(0, 8)}`,
        prompt: started.task ?? pending?.task ?? null,
        status: "running",
        startedAt: existing?.startedAt ?? now,
        completedAt: existing?.completedAt ?? null,
        result: existing?.result ?? null,
        error: existing?.error ?? null,
        profile: started.profile ?? pending?.profile ?? null,
        depth: started.depth ?? 1,
        isBackground: started.isBackground ?? pending?.isBackground ?? true,
        toolCallIds: [...(existing?.toolCallIds ?? []), toolCallId],
        pendingPermissions: existing?.pendingPermissions ?? [],
      };
      this.subagents.set(started.agentId, descriptor);
      return descriptor;
    }

    const completed = getMeta(update, "cognition.ai/subagent_completed") as
      | { agentId?: string; success?: boolean; summary?: string; depth?: number }
      | undefined;
    if (completed?.agentId) {
      const s = this.subagents.get(completed.agentId);
      if (!s) return null;
      s.completedAt = Date.now();
      if (completed.summary) {
        s.result = completed.summary;
        if (!completed.success) s.error = completed.summary;
      }
      if (completed.success) {
        s.status = s.pendingPermissions.length ? "waiting_for_permission" : "completed";
      } else {
        const summary = (completed.summary ?? "").toLowerCase();
        s.status = summary.includes("cancel") || summary.includes("cancelled") ? "cancelled" : "failed";
      }
      return s;
    }

    const subagentContext = getMeta(update, "cognition.ai/subagent_context") as
      | { parentAgentId?: string }
      | undefined;
    const parentAgentId = subagentContext?.parentAgentId;
    if (parentAgentId) {
      const s = this.subagents.get(parentAgentId);
      if (s && !s.toolCallIds.includes(toolCallId)) {
        s.toolCallIds.push(toolCallId);
        return s;
      }
    }

    const inferenceToolName = getMeta(update, "cognition.ai/inferenceToolName");
    if (inferenceToolName === "read_subagent" && update.status === "completed") {
      const rawInput = update.rawInput as Record<string, unknown> | undefined;
      const agentId = typeof rawInput?.agent_id === "string" ? rawInput.agent_id : null;
      const s = agentId ? this.subagents.get(agentId) : undefined;
      if (s) {
        const text = extractText(update.content);
        if (text && !s.result) s.result = text;
        if (s.status === "running") s.status = "completed";
        return s;
      }
    }

    return null;
  }

  private matchPendingCall(title: string | null, task: string | null): PendingSubagentCall | undefined {
    let best: PendingSubagentCall | undefined;
    // Prefer exact task match, then title match.
    for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
      const p = this.pendingCalls[i];
      if (p.task && task && p.task === task) {
        best = p;
        break;
      }
      if (p.title && title && p.title === title && !best) {
        best = p;
      }
    }
    if (best) {
      this.pendingCalls = this.pendingCalls.filter((p) => p !== best);
    }
    return best;
  }
}
