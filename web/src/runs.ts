import type { AgentActivity, AgentRun, SessionState, SubagentDescriptor, ToolCallState } from "./store-types";

function subagentStatusToActivity(status: SubagentDescriptor["status"]): AgentActivity["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
    case "waiting_for_permission":
      return "in_progress";
    case "starting":
    case "unknown":
    default:
      return "pending";
  }
}

function inferActivityType(tool: ToolCallState, session: SessionState): AgentActivity["type"] {
  const k = (tool.kind || "").toLowerCase();
  const t = (tool.title || "").toLowerCase();
  if (session.subagents[tool.id]) return "subagent";
  if (k.includes("subagent")) return "subagent";
  if (k.includes("edit") || k.includes("write") || t.includes("apply") || t.includes("write")) return "file_edit";
  if (k.includes("read") || t.includes("read") || t.includes("view")) return "file_read";
  if (k.includes("exec") || k.includes("bash") || k.includes("shell") || k.includes("command")) return "command";
  if (k.includes("test") || t.includes("test")) return "test";
  if (k.includes("plan") || t.includes("plan")) return "plan";
  if (t.includes("permission")) return "permission";
  return "command";
}

function makeActivity(tool: ToolCallState, session: SessionState): AgentActivity {
  const meta: AgentActivity["meta"] = {};
  for (const c of tool.content ?? []) {
    const item = c as { type: string; path?: string; terminalId?: string };
    if (item.type === "diff" && item.path) meta.path = item.path;
    if (item.type === "terminal" && item.terminalId) meta.terminalId = item.terminalId;
  }
  const raw = tool.rawInput as { command?: string } | undefined;
  if (raw?.command) meta.command = raw.command;

  const subagent = session.subagents[tool.id];
  if (subagent) {
    return {
      id: tool.id,
      type: "subagent",
      title: subagent.title ?? tool.title ?? tool.kind ?? "subagent",
      status: subagentStatusToActivity(subagent.status),
      startedAt: subagent.startedAt ?? tool.startedAt,
      completedAt: subagent.completedAt ?? tool.finishedAt ?? undefined,
      details: { subagent, rawInput: tool.rawInput, rawOutput: tool.rawOutput },
      autoExpand: subagent.status === "running" || subagent.status === "starting",
      children: [],
      subagentId: tool.id,
      meta,
    };
  }

  return {
    id: tool.id,
    type: inferActivityType(tool, session),
    title: tool.title || tool.kind || "tool",
    status: tool.status as AgentActivity["status"],
    startedAt: tool.startedAt,
    completedAt: tool.finishedAt ?? undefined,
    details: { rawInput: tool.rawInput, rawOutput: tool.rawOutput },
    autoExpand: tool.status === "in_progress",
    meta,
    subagentId: tool.subagentId ?? undefined,
  };
}

function buildSubagentActivity(
  id: string,
  root: AgentActivity | undefined,
  children: AgentActivity[],
  subagents: Record<string, SubagentDescriptor>,
): AgentActivity {
  const s = subagents[id];
  const firstChild = children[0];
  const title = root?.title ?? s?.title ?? firstChild?.title ?? "subagent";
  const status = root?.status ?? (s ? subagentStatusToActivity(s.status) : firstChild?.status ?? "in_progress");
  const startedAt = root?.startedAt ?? s?.startedAt ?? firstChild?.startedAt ?? Date.now();
  const completedAt = root?.completedAt ?? s?.completedAt ?? firstChild?.completedAt;
  return {
    id,
    type: "subagent",
    title,
    status,
    startedAt,
    completedAt,
    details: root?.details ?? (s ? { subagent: s } : undefined),
    autoExpand: status === "in_progress" || status === "pending",
    children: [...(root?.children ?? []), ...children],
    subagentId: id,
  };
}

function nestSubagentActivities(activities: AgentActivity[], subagents: Record<string, SubagentDescriptor>): AgentActivity[] {
  interface Group {
    root?: AgentActivity;
    children: AgentActivity[];
    firstIndex: number;
  }
  const groups = new Map<string, Group>();
  activities.forEach((a, i) => {
    if (a.type === "subagent" && a.subagentId && a.id === a.subagentId) {
      const g = groups.get(a.subagentId) ?? { children: [], firstIndex: i };
      g.root = a;
      groups.set(a.subagentId, g);
    } else if (a.subagentId) {
      const g = groups.get(a.subagentId) ?? { children: [], firstIndex: i };
      g.children.push(a);
      if (i < g.firstIndex) g.firstIndex = i;
      groups.set(a.subagentId, g);
    }
  });

  const emitted = new Set<string>();
  const result: AgentActivity[] = [];
  activities.forEach((a, i) => {
    if (!a.subagentId) {
      result.push(a);
      return;
    }
    const id = a.subagentId;
    if (emitted.has(id)) return;
    const g = groups.get(id);
    if (!g) {
      // No group info — emit as-is (shouldn't happen).
      result.push(a);
      return;
    }
    if (a.type === "subagent" && a.id === id) {
      emitted.add(id);
      result.push(buildSubagentActivity(id, g.root, g.children, subagents));
      return;
    }
    if (g.firstIndex === i) {
      emitted.add(id);
      result.push(buildSubagentActivity(id, g.root, g.children, subagents));
    }
  });
  return result;
}

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

/** Rebuild the `runs` record from the current timeline, messages, and tool calls. */
export function rebuildRuns(d: SessionState): void {
  const runs: Record<string, AgentRun> = {};
  let current: AgentRun | null = null;
  let assistantId = "";

  const finalize = () => {
    if (!current) return;
    if (current.status === "running") {
      current.status = runStatusFromSession(d.status, d.running);
    }
    if (current.status !== "running" && current.status !== "waiting_for_permission") {
      current.completedAt ??= Date.now();
    }
    current.activities = nestSubagentActivities(current.activities, d.subagents);
    runs[current.id] = current;
    current = null;
  };

  for (const item of d.timeline) {
    if (item.kind === "message") {
      const m = d.messages[item.id];
      if (!m) continue;
      if (m.role === "user") {
        finalize();
        current = {
          id: `${m.id}-run`,
          sessionId: d.sessionId,
          userMessageId: m.id,
          status: "running",
          startedAt: m.ts,
          activities: [],
          assistantText: "",
          plan: null,
          usage: null,
        };
        assistantId = "";
      } else {
        if (!current) {
          current = {
            id: `run-${m.id}`,
            sessionId: d.sessionId,
            userMessageId: m.id,
            status: "running",
            startedAt: m.ts,
            activities: [],
            assistantText: "",
            plan: null,
            usage: null,
          };
          assistantId = "";
        }
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
      if (!current) {
        current = {
          id: `run-${t.id}`,
          sessionId: d.sessionId,
          userMessageId: t.id,
          status: "running",
          startedAt: t.startedAt,
          activities: [],
          assistantText: "",
          plan: null,
          usage: null,
        };
      }
      const existing = current.activities.find((a) => a.id === t.id);
      if (existing) {
        const subagent = d.subagents[t.id];
        existing.status = subagent ? subagentStatusToActivity(subagent.status) : (t.status as AgentActivity["status"]);
        existing.completedAt = subagent?.completedAt ?? t.finishedAt ?? existing.completedAt;
      } else {
        current.activities.push(makeActivity(t, d));
      }
    }
  }

  finalize();

  // Surface current session plan/usage and permissions in the active (last) run.
  const ids = Object.keys(runs);
  if (ids.length > 0) {
    const last = runs[ids[ids.length - 1]];
    last.plan = d.plan;
    last.usage = d.usage;
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
