import type { AgentActivity, SessionState, SubagentDescriptor, ToolCallState } from "./store-types";

declare const __DEBUG_ACTIVITY__: boolean | undefined;

const DEBUG_ACTIVITY = typeof __DEBUG_ACTIVITY__ !== "undefined" && __DEBUG_ACTIVITY__ === true;

function debug(...args: unknown[]) {
  if (DEBUG_ACTIVITY) {
    // eslint-disable-next-line no-console
    console.warn("[activity]", ...args);
  }
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
  const title = subagent.title ?? `Subagent ${subagent.id.slice(0, 8)}`;
  const status = subagentStatusToActivity(subagent.status);
  return {
    id: subagent.id,
    type: "subagent",
    title,
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

function findSubagentIndex(subagent: SubagentDescriptor, runToolIds: string[]): number {
  let first = Infinity;
  if (subagent.parentToolCallId) {
    const idx = runToolIds.indexOf(subagent.parentToolCallId);
    if (idx >= 0) first = Math.min(first, idx);
  }
  for (const tcid of subagent.toolCallIds) {
    const idx = runToolIds.indexOf(tcid);
    if (idx >= 0) first = Math.min(first, idx);
  }
  return first === Infinity ? -1 : first;
}

function collectRelevantSubagentIds(runToolIds: string[], session: SessionState): Set<string> {
  const runToolSet = new Set(runToolIds);
  const subagentMap = session.subagents ?? {};
  const relevant = new Set<string>();

  for (const subagent of Object.values(subagentMap)) {
    if (subagent.parentToolCallId && runToolSet.has(subagent.parentToolCallId)) {
      relevant.add(subagent.id);
    }
    for (const tcid of subagent.toolCallIds) {
      if (runToolSet.has(tcid)) {
        relevant.add(subagent.id);
        break;
      }
    }
  }

  // If the run has no tool entries yet, surface all known subagents.
  if (runToolSet.size === 0) {
    for (const subagent of Object.values(subagentMap)) {
      relevant.add(subagent.id);
    }
  }

  // Include ancestors so nested hierarchy can be reconstructed.
  for (const id of new Set(relevant)) {
    let cur: string | null = subagentMap[id]?.parentSubagentId ?? null;
    while (cur && subagentMap[cur] && !relevant.has(cur)) {
      relevant.add(cur);
      cur = subagentMap[cur].parentSubagentId;
    }
  }

  return relevant;
}

/**
 * Build the Activity hierarchy for a single run from normalized session state.
 *
 * - One subagent activity per normalized descriptor.
 * - Tool calls are attached to their owning subagent via `toolCall.subagentId`.
 * - Subagent nesting follows `parentSubagentId`.
 * - Spawning `run_subagent` tool calls are suppressed in favor of the subagent card.
 * - Cycles and missing parents are broken safely.
 */
export function buildRunActivities(runToolIds: string[], session: SessionState): AgentActivity[] {
  const subagentMap = session.subagents ?? {};
  const toolCallMap = session.toolCalls ?? {};

  const relevant = collectRelevantSubagentIds(runToolIds, session);

  // Step 1: create one Activity node per relevant descriptor.
  const subagentById = new Map<string, AgentActivity>();
  for (const id of relevant) {
    const subagent = subagentMap[id];
    if (!subagent) continue;
    if (subagentById.has(id)) {
      debug("duplicate descriptor id", { subagentId: id.slice(0, 8) });
      continue;
    }
    subagentById.set(id, createSubagentActivity(subagent));
  }

  // Step 2: identify tools represented by subagents.
  const representedSpawnToolIds = new Set<string>(
    Object.values(subagentMap)
      .map((s) => s.parentToolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  const representedToolIds = new Set<string>(representedSpawnToolIds);
  for (const id of relevant) representedToolIds.add(id);

  // Map owned tool calls to their subagent.
  const toolsBySubagent = new Map<string, ToolCallState[]>();
  for (const tool of Object.values(toolCallMap)) {
    if (!tool) continue;
    if (representedToolIds.has(tool.id)) continue;
    const sid = tool.subagentId;
    if (sid && relevant.has(sid)) {
      const arr = toolsBySubagent.get(sid) ?? [];
      arr.push(tool);
      toolsBySubagent.set(sid, arr);
    }
  }

  // Attach owned tools to subagent nodes.
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
      const tc = toolCallMap[tcid];
      if (tc && !representedToolIds.has(tc.id)) {
        seen.add(tc.id);
        tools.push(tc);
      }
    }
    activity.children = sortActivities(tools.map(createToolActivity));
  }

  // Step 3: build parent/child relationships with cycle detection.
  const cycleNodes = new Set<string>();
  for (const id of relevant) {
    const path = new Set<string>();
    let cur: string | null = id;
    while (cur && relevant.has(cur)) {
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
  for (const id of relevant) {
    const parentId = subagentMap[id]?.parentSubagentId ?? null;
    if (parentId && relevant.has(parentId) && !cycleNodes.has(id)) {
      parentFor.set(id, parentId);
    } else {
      parentFor.set(id, null);
    }
  }

  const childrenByParent = new Map<string, AgentActivity[]>();
  for (const id of relevant) {
    const parentId = parentFor.get(id);
    if (parentId) {
      const children = childrenByParent.get(parentId) ?? [];
      const node = subagentById.get(id);
      if (node) children.push(node);
      childrenByParent.set(parentId, children);
    }
  }

  const built = new Set<string>();
  const rootSubagents: AgentActivity[] = [];

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

  const rootIds = [...relevant]
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
    const node = buildNode(id);
    if (node) rootSubagents.push(node);
  }

  // Diagnostics.
  for (const id of relevant) {
    const subagent = subagentMap[id];
    const parentId = subagent?.parentSubagentId;
    if (parentId && !relevant.has(parentId)) {
      debug("missing parent descriptor", { subagentId: id.slice(0, 8), parentId: parentId.slice(0, 8) });
    }
  }
  const seenDescriptorIds = new Set<string>();
  for (const subagent of Object.values(subagentMap)) {
    if (seenDescriptorIds.has(subagent.id)) {
      debug("duplicate descriptor id", { subagentId: subagent.id.slice(0, 8) });
    } else {
      seenDescriptorIds.add(subagent.id);
    }
  }
  for (const [sid, tools] of toolsBySubagent) {
    if (!relevant.has(sid)) {
      debug("tool referencing unknown subagent", { toolCount: tools.length, subagentId: sid.slice(0, 8) });
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
  for (const id of relevant) {
    if (parentFor.get(id)) continue;
    const idx = findSubagentIndex(subagentMap[id], runToolIds);
    if (idx >= 0) firstIndexBySubagent.set(id, idx);
  }

  const subagentsAtIndex = new Map<number, string[]>();
  for (const [id, idx] of firstIndexBySubagent) {
    const arr = subagentsAtIndex.get(idx) ?? [];
    arr.push(id);
    subagentsAtIndex.set(idx, arr);
  }

  for (let i = 0; i < runToolIds.length; i++) {
    const toolId = runToolIds[i];

    // Emit a subagent spawned at this tool call.
    if (representedSpawnToolIds.has(toolId)) {
      for (const subagent of Object.values(subagentMap)) {
        if (subagent.parentToolCallId === toolId && relevant.has(subagent.id) && !parentFor.get(subagent.id)) {
          emitSubagentRoot(subagent.id);
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
    if (tool.subagentId && relevant.has(tool.subagentId)) continue;
    result.push(createToolActivity(tool));
  }

  // Append any remaining top-level subagents (orphans or snapshot artifacts).
  const remainingRootIds = [...relevant]
    .filter((id) => !parentFor.get(id) && !emittedSubagent.has(id))
    .sort((a, b) => {
      const sa = subagentMap[a];
      const sb = subagentMap[b];
      const ta = sa?.startedAt ?? 0;
      const tb = sb?.startedAt ?? 0;
      if (ta !== tb) return ta - tb;
      return a.localeCompare(b);
    });
  for (const id of remainingRootIds) {
    emitSubagentRoot(id);
  }

  return result;
}
