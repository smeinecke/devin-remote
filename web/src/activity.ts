import type { AgentActivity, SessionState, SubagentDescriptor, ToolCallState } from "./store-types";

declare const __DEBUG_ACTIVITY__: boolean | undefined;

const DEBUG_ACTIVITY = typeof __DEBUG_ACTIVITY__ !== "undefined" && __DEBUG_ACTIVITY__ === true;

function debug(...args: unknown[]) {
  if (DEBUG_ACTIVITY) {
    // eslint-disable-next-line no-console
    console.warn("[activity]", ...args);
  }
}

export interface RunActivityContext {
  runId: string;
  toolCallIds: string[];
  toolSet: Set<string>;
  toolOrder: Map<string, number>;
  startedAt: number;
  endedAt: number | null;
  isCurrentRun: boolean;
}

export function isTerminalSubagentStatus(status: SubagentDescriptor["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function subagentStatusToActivity(status: SubagentDescriptor["status"]): AgentActivity["status"] {
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

function toolStatusToActivity(status: string): AgentActivity["status"] {
  const s = (status ?? "").toLowerCase();
  switch (s) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "in_progress":
      return "in_progress";
    case "pending":
      return "pending";
    default:
      return "in_progress";
  }
}

function inferActivityType(tool: ToolCallState): AgentActivity["type"] {
  const k = (tool.kind || "").toLowerCase();
  const t = (tool.title || "").toLowerCase();
  if (k.includes("subagent")) return "subagent";
  if (k.includes("edit") || k.includes("write") || t.includes("apply") || t.includes("write")) return "file_edit";
  if (k.includes("read") || t.includes("read") || t.includes("view")) return "file_read";
  if (k.includes("exec") || k.includes("bash") || k.includes("shell") || k.includes("command")) return "command";
  if (k.includes("test") || t.includes("test")) return "test";
  if (k.includes("plan") || t.includes("plan")) return "plan";
  if (t.includes("permission")) return "permission";
  return "command";
}

function compactPreview(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  const first = s.split(/\r?\n/)[0].trim();
  if (first.length <= max) return first;
  return first.slice(0, max - 1) + "…";
}

export function createToolActivity(tool: ToolCallState): AgentActivity {
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
    status: toolStatusToActivity(tool.status),
    startedAt: tool.startedAt,
    completedAt: tool.finishedAt ?? undefined,
    details: { rawInput: tool.rawInput, rawOutput: tool.rawOutput },
    autoExpand: tool.status === "in_progress",
    meta,
    toolCallId: tool.id,
    subagentId: tool.subagentId ?? undefined,
  };
}

export function createSubagentActivity(subagent: SubagentDescriptor): AgentActivity {
  const label = subagent.title?.trim() || compactPreview(subagent.prompt, 80) || "Delegated task";
  const status = subagentStatusToActivity(subagent.status);
  return {
    id: subagent.id,
    type: "subagent",
    title: label,
    status,
    startedAt: subagent.startedAt ?? 0,
    completedAt: subagent.completedAt ?? undefined,
    details: { subagent },
    autoExpand:
      subagent.status === "running" ||
      subagent.status === "starting" ||
      subagent.status === "waiting_for_permission" ||
      subagent.status === "failed",
    children: [],
    subagentId: subagent.id,
  };
}

function sortActivities(activities: AgentActivity[]): AgentActivity[] {
  return [...activities].sort((a, b) => {
    const ta = a.startedAt ?? 0;
    const tb = b.startedAt ?? 0;
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}

function findSubagentIndex(subagent: SubagentDescriptor | undefined, toolOrder: Map<string, number>): number {
  if (!subagent) return -1;
  let first = Infinity;
  if (subagent.parentToolCallId) {
    const idx = toolOrder.get(subagent.parentToolCallId);
    if (idx !== undefined) first = Math.min(first, idx);
  }
  for (const tcid of subagent.toolCallIds) {
    const idx = toolOrder.get(tcid);
    if (idx !== undefined) first = Math.min(first, idx);
  }
  return first === Infinity ? -1 : first;
}

/**
 * Build the Activity hierarchy for a single run from normalized session state.
 *
 * - `relevantSubagentIds` is the precomputed set of subagents that belong to this run.
 * - Tool calls are attached to their owning subagent only when the tool is part of this run.
 * - Subagent nesting follows `parentSubagentId` within this run.
 * - Spawning `run_subagent` tool calls are suppressed in favor of the subagent card.
 * - Cycles and missing parents are broken safely.
 */
export function buildRunActivities(
  context: RunActivityContext,
  session: SessionState,
  relevantSubagentIds: Set<string>,
): AgentActivity[] {
  const subagentMap = session.subagents ?? {};
  const toolCallMap = session.toolCalls ?? {};

  // Step 1: create one Activity node per relevant descriptor.
  const subagentById = new Map<string, AgentActivity>();
  for (const id of relevantSubagentIds) {
    const subagent = subagentMap[id];
    if (!subagent) continue;
    if (subagentById.has(id)) {
      debug("duplicate descriptor id", { subagentId: id.slice(0, 8) });
      continue;
    }
    subagentById.set(id, createSubagentActivity(subagent));
  }

  // Step 2: identify tools represented by subagents for this run.
  const representedSpawnToolIds = new Set<string>();
  for (const id of relevantSubagentIds) {
    const ptid = subagentMap[id]?.parentToolCallId;
    if (ptid && context.toolSet.has(ptid)) representedSpawnToolIds.add(ptid);
  }

  const representedToolIds = new Set<string>(representedSpawnToolIds);
  for (const id of relevantSubagentIds) representedToolIds.add(id);

  // Map owned tool calls within this run to their subagent.
  const toolsBySubagent = new Map<string, ToolCallState[]>();
  for (const toolId of context.toolCallIds) {
    const tool = toolCallMap[toolId];
    if (!tool) continue;
    if (representedToolIds.has(tool.id)) continue;
    const sid = tool.subagentId;
    if (sid && relevantSubagentIds.has(sid)) {
      const arr = toolsBySubagent.get(sid) ?? [];
      arr.push(tool);
      toolsBySubagent.set(sid, arr);
    }
  }

  // Attach owned tools to subagent nodes, limited to tools in this run.
  for (const [sid, activity] of subagentById) {
    const subagent = subagentMap[sid];
    if (!subagent) continue;
    const seen = new Set<string>();
    const tools: ToolCallState[] = [];
    for (const t of toolsBySubagent.get(sid) ?? []) {
      if (seen.has(t.id) || t.id === sid) continue;
      seen.add(t.id);
      tools.push(t);
    }
    for (const tcid of subagent.toolCallIds) {
      if (tcid === sid || seen.has(tcid)) continue;
      if (!context.toolSet.has(tcid)) continue;
      const tc = toolCallMap[tcid];
      if (tc && !representedToolIds.has(tc.id)) {
        seen.add(tc.id);
        tools.push(tc);
      }
    }
    activity.children = sortActivities(tools.map(createToolActivity));
  }

  // Step 3: build parent/child relationships with cycle detection within this run.
  const cycleNodes = new Set<string>();
  for (const id of relevantSubagentIds) {
    const path = new Set<string>();
    let cur: string | null = id;
    while (cur && relevantSubagentIds.has(cur)) {
      if (path.has(cur)) {
        let c: string | null = cur;
        do {
          if (c) cycleNodes.add(c);
          c = subagentMap[c]?.parentSubagentId ?? null;
        } while (c && c !== cur);
        break;
      }
      path.add(cur);
      cur = subagentMap[cur]?.parentSubagentId ?? null;
    }
  }

  const parentFor = new Map<string, string | null>();
  for (const id of relevantSubagentIds) {
    const parentId = subagentMap[id]?.parentSubagentId ?? null;
    if (parentId && relevantSubagentIds.has(parentId) && !cycleNodes.has(id)) {
      parentFor.set(id, parentId);
    } else {
      parentFor.set(id, null);
    }
  }

  const childrenByParent = new Map<string, AgentActivity[]>();
  for (const id of relevantSubagentIds) {
    const parentId = parentFor.get(id);
    if (parentId) {
      const children = childrenByParent.get(parentId) ?? [];
      const node = subagentById.get(id);
      if (node) children.push(node);
      childrenByParent.set(parentId, children);
    }
  }

  const built = new Set<string>();
  function buildNode(id: string): AgentActivity | null {
    if (built.has(id)) return subagentById.get(id) ?? null;
    const node = subagentById.get(id);
    if (!node) return null;
    const childSubagents = (childrenByParent.get(id) ?? [])
      .map((c) => buildNode(c.subagentId!))
      .filter((c): c is AgentActivity => c !== null);
    const existingChildren = node.children ?? [];
    node.children = sortActivities([...existingChildren, ...childSubagents]);
    built.add(id);
    return node;
  }

  const rootIds = [...relevantSubagentIds]
    .filter((id) => !parentFor.get(id))
    .sort((a, b) => {
      const sa = subagentMap[a];
      const sb = subagentMap[b];
      const ta = sa?.startedAt ?? 0;
      const tb = sb?.startedAt ?? 0;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });

  for (const id of rootIds) {
    buildNode(id);
  }

  // Diagnostics.
  for (const id of relevantSubagentIds) {
    const subagent = subagentMap[id];
    const parentId = subagent?.parentSubagentId;
    if (parentId && !relevantSubagentIds.has(parentId) && subagentMap[parentId]) {
      debug("missing parent descriptor in run", {
        runId: context.runId.slice(0, 8),
        subagentId: id.slice(0, 8),
        parentId: parentId.slice(0, 8),
      });
    }
  }

  // Step 4: order top-level activities by run tool order.
  const emittedSubagent = new Set<string>();
  const result: AgentActivity[] = [];

  function emitSubagentRoot(id: string) {
    if (emittedSubagent.has(id)) return;
    emittedSubagent.add(id);
    const node = subagentById.get(id);
    if (node) result.push(node);
  }

  const firstIndexBySubagent = new Map<string, number>();
  for (const id of relevantSubagentIds) {
    if (parentFor.get(id)) continue;
    const idx = findSubagentIndex(subagentMap[id], context.toolOrder);
    if (idx >= 0) firstIndexBySubagent.set(id, idx);
  }

  const subagentsAtIndex = new Map<number, string[]>();
  for (const [id, idx] of firstIndexBySubagent) {
    const arr = subagentsAtIndex.get(idx) ?? [];
    arr.push(id);
    subagentsAtIndex.set(idx, arr);
  }

  for (let i = 0; i < context.toolCallIds.length; i++) {
    const toolId = context.toolCallIds[i];

    // Emit a subagent spawned at this tool call.
    if (representedSpawnToolIds.has(toolId)) {
      for (const id of relevantSubagentIds) {
        const subagent = subagentMap[id];
        if (subagent?.parentToolCallId === toolId && !parentFor.get(id)) {
          emitSubagentRoot(id);
        }
      }
    }

    // Emit top-level subagents whose first owned/spawn tool appears here.
    for (const sid of subagentsAtIndex.get(i) ?? []) {
      if (!parentFor.get(sid)) emitSubagentRoot(sid);
    }

    // Emit a generic main-agent tool if it is not represented and not owned.
    if (representedToolIds.has(toolId)) continue;
    const tool = toolCallMap[toolId];
    if (!tool) continue;
    if (tool.subagentId && relevantSubagentIds.has(tool.subagentId)) continue;
    result.push(createToolActivity(tool));
  }

  // Append any remaining top-level subagents (orphans or snapshot artifacts).
  const remainingRootIds = [...relevantSubagentIds]
    .filter((id) => !parentFor.get(id) && !emittedSubagent.has(id))
    .sort((a, b) => {
      const ta = subagentMap[a]?.startedAt ?? 0;
      const tb = subagentMap[b]?.startedAt ?? 0;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  for (const id of remainingRootIds) {
    emitSubagentRoot(id);
  }

  return result;
}
