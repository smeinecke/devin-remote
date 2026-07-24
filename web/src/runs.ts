import type { AgentRun, ChatMessage, SessionState, SubagentDescriptor, ToolCallState } from "./store-types";
import { buildRunActivities, isTerminalSubagentStatus } from "./activity";

function runStatusFromSession(status: SessionState["status"], running: boolean): AgentRun["status"] {
  if (running) return "running";
  switch (status) {
    case "waiting_for_permission":
      return "waiting_for_permission";
    case "failed":
    case "disconnected":
    case "closed":
      return "failed";
    case "cancelling":
      return "cancelled";
    case "idle":
    case "loading":
      return "completed";
    default:
      return "running";
  }
}

interface RunBuilder {
  id: string;
  userMessageId: string;
  startedAt: number;
  endedAt: number | null;
  toolCallIds: string[];
  assistantText: string;
  finalMessageId?: string;
}

function getMessageTimestamp(m: ChatMessage | ToolCallState): number {
  return "ts" in m && m.ts != null ? m.ts : Date.now();
}

/** Rebuild the `runs` record from the current timeline, messages, and tool calls. */
export function rebuildRuns(d: SessionState): void {
  const builders: RunBuilder[] = [];
  let current: RunBuilder | null = null;
  let assistantId = "";

  const startRun = (id: string, userMessageId: string, startedAt: number): RunBuilder => {
    const run: RunBuilder = {
      id,
      userMessageId,
      startedAt,
      endedAt: null,
      toolCallIds: [],
      assistantText: "",
    };
    assistantId = "";
    builders.push(run);
    current = run;
    return run;
  };

  const closeCurrent = (endedAt: number) => {
    if (current && (current.endedAt === null || endedAt < current.endedAt)) {
      current.endedAt = endedAt;
    }
  };

  for (const item of d.timeline) {
    if (item.kind === "message") {
      const m = d.messages[item.id];
      if (!m) continue;
      if (m.role === "user") {
        closeCurrent(m.ts);
        current = startRun(`${m.id}-run`, m.id, m.ts);
      } else {
        if (!current) current = startRun(`run-${m.id}`, m.id, m.ts);
        if (m.role === "thought") {
          current.assistantText += (current.assistantText ? "\n\n" : "") + `> ${m.text}`;
        } else {
          current.assistantText += (current.assistantText ? "" : "") + m.text;
          if (!assistantId) assistantId = m.id;
        }
        current.finalMessageId = assistantId || m.id;
      }
      continue;
    }

    if (item.kind === "tool") {
      const t = d.toolCalls[item.id];
      if (!t) continue;
      if (!current) current = startRun(`run-${t.id}`, t.id, t.startedAt);
      current.toolCallIds.push(item.id);
    }
  }

  // Deterministic subagent-to-run attribution.
  const runByToolId = new Map<string, string>();
  for (const run of builders) {
    for (const tid of run.toolCallIds) {
      runByToolId.set(tid, run.id);
    }
  }

  const subagentMap = d.subagents ?? {};
  const subagentToRun = new Map<string, string>();

  for (const subagent of Object.values(subagentMap)) {
    const runId = assignSubagentToRun(subagent, builders, runByToolId);
    if (runId) subagentToRun.set(subagent.id, runId);
  }

  const subagentIdsByRun = new Map<string, Set<string>>();
  for (const [sid, rid] of subagentToRun) {
    const set = subagentIdsByRun.get(rid) ?? new Set<string>();
    set.add(sid);
    subagentIdsByRun.set(rid, set);
  }

  // Build each run's activities using precomputed run-scoped subagents and tools.
  const runs: Record<string, AgentRun> = {};
  for (let i = 0; i < builders.length; i++) {
    const rb = builders[i];
    const isLast = i === builders.length - 1;
    const runStatus = isLast ? runStatusFromSession(d.status, d.running) : "completed";
    const toolSet = new Set(rb.toolCallIds);
    const toolOrder = new Map<string, number>();
    rb.toolCallIds.forEach((id, idx) => toolOrder.set(id, idx));
    const relevant = subagentIdsByRun.get(rb.id) ?? new Set<string>();

    const context = {
      runId: rb.id,
      toolCallIds: rb.toolCallIds,
      toolSet,
      toolOrder,
      startedAt: rb.startedAt,
      endedAt: rb.endedAt,
      isCurrentRun: isLast,
    };
    const activities = buildRunActivities(context, d, relevant);

    runs[rb.id] = {
      id: rb.id,
      sessionId: d.sessionId,
      userMessageId: rb.userMessageId,
      status: runStatus,
      startedAt: rb.startedAt,
      endedAt: rb.endedAt ?? undefined,
      toolCallIds: rb.toolCallIds,
      activities,
      finalMessageId: rb.finalMessageId,
      assistantText: rb.assistantText,
      plan: isLast ? d.plan : null,
      usage: isLast ? d.usage : null,
    };

    if (isLast && runStatus !== "running" && runStatus !== "waiting_for_permission") {
      runs[rb.id].completedAt ??= Date.now();
    }
  }

  // Surface current session plan/usage and permissions in the active (last) run.
  const lastRun = builders[builders.length - 1];
  if (lastRun) {
    const last = runs[lastRun.id];
    for (const p of d.permissions) {
      if (!last.activities.find((a) => a.id === p.requestId)) {
        last.activities.push({
          id: p.requestId,
          type: "permission",
          title: String(p.toolCall.title ?? p.toolCall.kind ?? "permission"),
          status: "in_progress",
          startedAt: Date.now(),
          details: p,
        });
      }
    }
  }

  d.runs = runs;
}

function assignSubagentToRun(
  subagent: SubagentDescriptor,
  runs: RunBuilder[],
  runByToolId: Map<string, string>,
): string | null {
  if (runs.length === 0) return null;

  // 1. Strongest: the spawning tool call belongs to a run.
  if (subagent.parentToolCallId && runByToolId.has(subagent.parentToolCallId)) {
    return runByToolId.get(subagent.parentToolCallId)!;
  }

  // 2. Strong: an owned tool call belongs to a run.
  for (const tcid of subagent.toolCallIds) {
    if (runByToolId.has(tcid)) {
      return runByToolId.get(tcid)!;
    }
  }

  const startedAt = subagent.startedAt ?? null;

  // 3. Timestamp boundary match.
  if (startedAt !== null) {
    for (const run of runs) {
      if (startedAt >= run.startedAt && (run.endedAt === null || startedAt < run.endedAt)) {
        return run.id;
      }
    }

    // Nearest previous run.
    let nearest: RunBuilder | null = null;
    for (const run of runs) {
      if (run.startedAt <= startedAt && (!nearest || run.startedAt > nearest.startedAt)) {
        nearest = run;
      }
    }
    if (nearest) return nearest.id;
  }

  // 4. Uncorrelated active subagent belongs to the current run.
  const lastRun = runs[runs.length - 1];
  if (!isTerminalSubagentStatus(subagent.status)) {
    return lastRun.id;
  }

  // 5. Historical uncorrelated fallback to the earliest run for determinism.
  return runs[0].id;
}
