import type { AgentRun, SessionState } from "./store-types";
import { buildRunActivities } from "./activity";

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
  let runToolIds: string[] = [];

  const finalize = () => {
    if (!current) return;
    if (current.status === "running") {
      current.status = runStatusFromSession(d.status, d.running);
    }
    if (current.status !== "running" && current.status !== "waiting_for_permission") {
      current.completedAt ??= Date.now();
    }
    current.activities = buildRunActivities(runToolIds, d);
    runs[current.id] = current;
    current = null;
    runToolIds = [];
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
      runToolIds.push(item.id);
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
