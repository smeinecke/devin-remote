import type { AgentActivity, AgentRun, SessionState, ToolCallState } from "./store-types";

function inferActivityType(tool: ToolCallState): AgentActivity["type"] {
  const k = (tool.kind || "").toLowerCase();
  const t = (tool.title || "").toLowerCase();
  if (k.includes("edit") || k.includes("write") || t.includes("apply") || t.includes("write")) return "file_edit";
  if (k.includes("read") || t.includes("read") || t.includes("view")) return "file_read";
  if (k.includes("exec") || k.includes("bash") || k.includes("shell") || k.includes("command")) return "command";
  if (k.includes("test") || t.includes("test")) return "test";
  if (k.includes("subagent") || k.includes("agent")) return "subagent";
  if (k.includes("plan") || t.includes("plan")) return "plan";
  if (t.includes("permission")) return "permission";
  return "command";
}

function makeActivity(tool: ToolCallState): AgentActivity {
  const meta: AgentActivity["meta"] = {};
  for (const c of tool.content ?? []) {
    const item = c as { type: string; path?: string; terminalId?: string };
    if (item.type === "diff" && item.path) meta.path = item.path;
    if (item.type === "terminal" && item.terminalId) meta.terminalId = item.terminalId;
  }
  const raw = tool.rawInput as { command?: string } | undefined;
  if (raw?.command) meta.command = raw.command;

  return {
    id: tool.id,
    type: inferActivityType(tool),
    title: tool.title || tool.kind || "tool",
    status: tool.status as AgentActivity["status"],
    startedAt: tool.startedAt,
    completedAt: tool.finishedAt ?? undefined,
    details: { rawInput: tool.rawInput, rawOutput: tool.rawOutput },
    autoExpand: tool.status === "in_progress",
    meta,
  };
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
        existing.status = t.status as AgentActivity["status"];
        existing.completedAt = t.finishedAt ?? undefined;
      } else {
        current.activities.push(makeActivity(t));
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
