import { describe, it, expect } from "vitest";
import { buildRunActivities, createSubagentActivity, createToolActivity, type RunActivityContext } from "./activity";
import { rebuildRuns } from "./runs";
import type { SessionState, SubagentDescriptor, ToolCallState } from "./store-types";

function subagent(overrides: Partial<SubagentDescriptor> & { id: string }): SubagentDescriptor {
  return {
    sessionId: "s1",
    processGeneration: 1,
    parentSubagentId: null,
    parentToolCallId: null,
    title: null,
    prompt: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    result: null,
    error: null,
    profile: null,
    depth: 1,
    isBackground: false,
    toolCallIds: [],
    pendingPermissions: [],
    ...overrides,
  };
}

function tool(overrides: Partial<ToolCallState> & { id: string }): ToolCallState {
  return {
    title: overrides.title ?? `Tool ${overrides.id}`,
    kind: overrides.kind ?? "command",
    status: overrides.status ?? "completed",
    content: [],
    startedAt: overrides.startedAt ?? 1000,
    finishedAt: overrides.finishedAt ?? null,
    subagentId: overrides.subagentId ?? null,
    ...overrides,
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s1",
    cwd: "/tmp",
    title: null,
    alias: null,
    branch: null,
    worktree: null,
    updatedAt: null,
    processGeneration: 1,
    status: "running",
    timeline: [],
    messages: {},
    toolCalls: {},
    subagents: {},
    runs: {},
    plan: null,
    usage: null,
    configOptions: [],
    currentModeId: null,
    availableCommands: [],
    permissions: [],
    running: true,
    synced: true,
    unread: false,
    openAgentMsg: null,
    openThoughtMsg: null,
    openUserMsg: null,
    lastSequence: 0,
    activePromptRequest: null,
    ...overrides,
  };
}

function context(
  runId: string,
  toolCallIds: string[],
  { startedAt = 0, endedAt = null, isCurrentRun = true }: Partial<RunActivityContext> = {},
): RunActivityContext {
  return {
    runId,
    toolCallIds,
    toolSet: new Set(toolCallIds),
    toolOrder: new Map(toolCallIds.map((id, idx) => [id, idx])),
    startedAt,
    endedAt,
    isCurrentRun,
  };
}

function collectIds(activities: Array<{ id: string; children?: Array<{ id: string }> }>): string[] {
  const out: string[] = [];
  for (const a of activities) {
    out.push(a.id);
    if (a.children) out.push(...collectIds(a.children));
  }
  return out;
}

describe("buildRunActivities", () => {
  it("renders a subagent with no tools", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1" }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1", title: "Run subagent", kind: "run_subagent" }) },
    });
    const acts = buildRunActivities(context("r1", ["spawn-1"]), s, new Set(["sub-a"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("sub-a");
    expect(acts[0].children).toHaveLength(0);
  });

  it("attaches an owned tool to its subagent", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", toolCallIds: ["tool-1"] }) },
      toolCalls: { "tool-1": tool({ id: "tool-1", subagentId: "sub-a" }) },
    });
    const acts = buildRunActivities(context("r1", ["tool-1"]), s, new Set(["sub-a"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("sub-a");
    expect(acts[0].children).toHaveLength(1);
    expect(acts[0].children![0].id).toBe("tool-1");
  });

  it("keeps two subagent tool sets separate", () => {
    const s = session({
      subagents: {
        "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-a", toolCallIds: ["tool-a"] }),
        "sub-b": subagent({ id: "sub-b", parentToolCallId: "spawn-b", toolCallIds: ["tool-b"] }),
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a", title: "Run subagent" }),
        "tool-a": tool({ id: "tool-a", subagentId: "sub-a" }),
        "spawn-b": tool({ id: "spawn-b", title: "Run subagent" }),
        "tool-b": tool({ id: "tool-b", subagentId: "sub-b" }),
      },
    });
    const acts = buildRunActivities(context("r1", ["spawn-a", "tool-a", "spawn-b", "tool-b"]), s, new Set(["sub-a", "sub-b"]));
    const a = acts.find((x) => x.id === "sub-a")!;
    const b = acts.find((x) => x.id === "sub-b")!;
    expect(a.children!.map((c) => c.id)).toEqual(["tool-a"]);
    expect(b.children!.map((c) => c.id)).toEqual(["tool-b"]);
  });

  it("nests a child subagent under its parentSubagentId", () => {
    const s = session({
      subagents: {
        parent: subagent({ id: "parent", parentToolCallId: "spawn-parent" }),
        child: subagent({ id: "child", parentSubagentId: "parent", parentToolCallId: "spawn-child", toolCallIds: ["child-tool"] }),
      },
      toolCalls: {
        "spawn-parent": tool({ id: "spawn-parent" }),
        "spawn-child": tool({ id: "spawn-child", subagentId: "parent" }),
        "child-tool": tool({ id: "child-tool", subagentId: "child" }),
      },
    });
    const acts = buildRunActivities(context("r1", ["spawn-parent", "spawn-child", "child-tool"]), s, new Set(["parent", "child"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("parent");
    expect(acts[0].children![0].id).toBe("child");
    expect(acts[0].children![0].children![0].id).toBe("child-tool");
  });

  it("renders a missing parent as a root orphan", () => {
    const s = session({
      subagents: { orphan: subagent({ id: "orphan", parentSubagentId: "missing", toolCallIds: ["tool-1"] }) },
      toolCalls: { "tool-1": tool({ id: "tool-1", subagentId: "orphan" }) },
    });
    const acts = buildRunActivities(context("r1", ["tool-1"]), s, new Set(["orphan"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("orphan");
  });

  it("does not recurse infinitely on a self-cycle", () => {
    const s = session({
      subagents: { a: subagent({ id: "a", parentSubagentId: "a" }) },
    });
    const acts = buildRunActivities(context("r1", []), s, new Set(["a"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("a");
  });

  it("breaks a multi-node cycle without crashing", () => {
    const s = session({
      subagents: {
        a: subagent({ id: "a", parentSubagentId: "b" }),
        b: subagent({ id: "b", parentSubagentId: "a" }),
      },
    });
    const acts = buildRunActivities(context("r1", []), s, new Set(["a", "b"]));
    expect(acts.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(acts.map((a) => a.id));
    expect(ids.has("a") || ids.has("b")).toBe(true);
  });

  it("suppresses the spawning run_subagent tool", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1" }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1", title: "Run subagent", kind: "run_subagent" }) },
    });
    const acts = buildRunActivities(context("r1", ["spawn-1"]), s, new Set(["sub-a"]));
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("sub-a");
    expect(acts.every((a) => a.id !== "spawn-1")).toBe(true);
  });

  it("keeps unrelated main-agent tools visible", () => {
    const s = session({
      toolCalls: { "tool-1": tool({ id: "tool-1" }) },
    });
    const acts = buildRunActivities(context("r1", ["tool-1"]), s, new Set());
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("tool-1");
  });

  it("does not duplicate activity entries for duplicate descriptor updates", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1" }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1" }) },
    });
    const relevant = new Set(["sub-a"]);
    const ctx = context("r1", ["spawn-1"]);
    const acts1 = buildRunActivities(ctx, s, relevant);
    const acts2 = buildRunActivities(ctx, s, relevant);
    expect(acts1).toHaveLength(1);
    expect(acts2).toHaveLength(1);
  });

  it("orders top-level orphan subagents by startedAt", () => {
    const s = session({
      subagents: {
        second: subagent({ id: "second", startedAt: 2000 }),
        first: subagent({ id: "first", startedAt: 1000 }),
      },
    });
    const acts = buildRunActivities(context("r1", []), s, new Set(["first", "second"]));
    expect(acts[0].id).toBe("first");
    expect(acts[1].id).toBe("second");
  });

  it("keeps simultaneous identical tasks distinct by id", () => {
    const s = session({
      subagents: {
        a: subagent({ id: "a", title: "Same task", parentToolCallId: "spawn-a", startedAt: 1000 }),
        b: subagent({ id: "b", title: "Same task", parentToolCallId: "spawn-b", startedAt: 1000 }),
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a" }),
        "spawn-b": tool({ id: "spawn-b" }),
      },
    });
    const acts = buildRunActivities(context("r1", ["spawn-a", "spawn-b"]), s, new Set(["a", "b"]));
    expect(acts).toHaveLength(2);
    expect(new Set(acts.map((a) => a.id))).toEqual(new Set(["a", "b"]));
  });

  it("only attaches tools that belong to the run", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", toolCallIds: ["tool-a", "tool-other"] }) },
      toolCalls: {
        "tool-a": tool({ id: "tool-a", subagentId: "sub-a" }),
        "tool-other": tool({ id: "tool-other", subagentId: "sub-a" }),
      },
    });
    const acts = buildRunActivities(context("r1", ["tool-a"]), s, new Set(["sub-a"]));
    expect(acts[0].children!.map((c) => c.id)).toEqual(["tool-a"]);
  });
});

describe("createToolActivity", () => {
  it("infers command type from kind", () => {
    const t = tool({ id: "t1", kind: "bash_command" });
    const act = createToolActivity(t);
    expect(act.type).toBe("command");
    expect(act.toolCallId).toBe("t1");
  });
});

describe("createSubagentActivity", () => {
  it("prefers title, then prompt preview, then generic label", () => {
    const fromTitle = createSubagentActivity(subagent({ id: "a", title: "  My title  " }));
    expect(fromTitle.title).toBe("My title");

    const fromPrompt = createSubagentActivity(subagent({ id: "b", title: "", prompt: " npm test\nmore" }));
    expect(fromPrompt.title).toBe("npm test");

    const fallback = createSubagentActivity(subagent({ id: "c", title: "", prompt: "" }));
    expect(fallback.title).toBe("Delegated task");
  });

  it("sets autoExpand for a failed subagent", () => {
    const s = subagent({ id: "a", status: "failed", error: "Database connection refused" });
    const act = createSubagentActivity(s);
    expect(act.autoExpand).toBe(true);
  });
});

describe("rebuildRuns multi-run attribution", () => {
  it("keeps a subagent in the run that spawned it", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-a" },
        { kind: "tool", id: "tool-a" },
        { kind: "message", id: "user-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "tool-a": tool({ id: "tool-a", subagentId: "sub-a", startedAt: 3000 }),
      },
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-a", toolCallIds: ["tool-a"], startedAt: 2000 }) },
    });
    rebuildRuns(s);
    const runs = Object.values(s.runs);
    expect(runs).toHaveLength(2);
    const runA = runs.find((r) => r.userMessageId === "user-a")!;
    const runB = runs.find((r) => r.userMessageId === "user-b")!;
    expect(runA.activities.map((a) => a.id)).toContain("sub-a");
    expect(runB.activities.map((a) => a.id)).not.toContain("sub-a");
  });

  it("does not leak an owned tool into a later run", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-a" },
        { kind: "tool", id: "tool-a" },
        { kind: "message", id: "user-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "tool-a": tool({ id: "tool-a", subagentId: "sub-a", startedAt: 3000 }),
      },
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-a", toolCallIds: ["tool-a"], startedAt: 2000 }) },
    });
    rebuildRuns(s);
    const runs = Object.values(s.runs);
    const runA = runs.find((r) => r.userMessageId === "user-a")!;
    const runB = runs.find((r) => r.userMessageId === "user-b")!;
    const allIdsA = collectIds(runA.activities);
    const allIdsB = collectIds(runB.activities);
    expect(allIdsA).toContain("tool-a");
    expect(allIdsB).not.toContain("tool-a");
    expect(allIdsB).not.toContain("sub-a");
  });

  it("places each of two distinct subagents in its own run", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-a" },
        { kind: "message", id: "user-b" },
        { kind: "tool", id: "spawn-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "spawn-b": tool({ id: "spawn-b", title: "Run subagent", kind: "run_subagent", startedAt: 6000 }),
      },
      subagents: {
        "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-a", startedAt: 2000 }),
        "sub-b": subagent({ id: "sub-b", parentToolCallId: "spawn-b", startedAt: 6000 }),
      },
    });
    rebuildRuns(s);
    const runA = s.runs["user-a-run"];
    const runB = s.runs["user-b-run"];
    expect(runA.activities.map((a) => a.id)).toContain("sub-a");
    expect(runB.activities.map((a) => a.id)).toContain("sub-b");
    expect(runA.activities.map((a) => a.id)).not.toContain("sub-b");
    expect(runB.activities.map((a) => a.id)).not.toContain("sub-a");
  });

  it("assigns a tool-less subagent to the correct run by timestamp", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "main-tool" },
        { kind: "message", id: "user-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      toolCalls: {
        "main-tool": tool({ id: "main-tool", startedAt: 2000 }),
      },
      subagents: { "sub-a": subagent({ id: "sub-a", startedAt: 1500, status: "completed", completedAt: 2500 }) },
    });
    rebuildRuns(s);
    const runA = s.runs["user-a-run"];
    const runB = s.runs["user-b-run"];
    expect(runA.activities.map((a) => a.id)).toContain("sub-a");
    expect(runB.activities.map((a) => a.id)).not.toContain("sub-a");
  });

  it("assigns an uncorrelated active subagent only to the latest run", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "message", id: "user-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      subagents: { active: subagent({ id: "active", status: "running", startedAt: 6000 }) },
    });
    rebuildRuns(s);
    const runA = s.runs["user-a-run"];
    const runB = s.runs["user-b-run"];
    expect(runA.activities.map((a) => a.id)).not.toContain("active");
    expect(runB.activities.map((a) => a.id)).toContain("active");
  });

  it("keeps nested subagents inside their owning run", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-parent" },
        { kind: "tool", id: "spawn-child" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
      },
      toolCalls: {
        "spawn-parent": tool({ id: "spawn-parent", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "spawn-child": tool({ id: "spawn-child", title: "Run subagent", kind: "run_subagent", subagentId: "parent", startedAt: 3000 }),
      },
      subagents: {
        parent: subagent({ id: "parent", parentToolCallId: "spawn-parent", startedAt: 2000 }),
        child: subagent({ id: "child", parentSubagentId: "parent", parentToolCallId: "spawn-child", startedAt: 3000 }),
      },
    });
    rebuildRuns(s);
    const runA = s.runs["user-a-run"];
    const parent = runA.activities.find((a) => a.id === "parent")!;
    expect(parent).toBeDefined();
    expect(parent.children!.map((c) => c.id)).toContain("child");
  });

  it("reconstructs the same hierarchy from snapshot state", () => {
    const s = session({
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-a" },
        { kind: "tool", id: "tool-a" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "tool-a": tool({ id: "tool-a", subagentId: "sub-a", startedAt: 3000 }),
      },
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-a", toolCallIds: ["tool-a"], startedAt: 2000 }) },
    });
    rebuildRuns(s);
    const first = JSON.stringify(s.runs["user-a-run"].activities.map((a) => a.id));
    rebuildRuns(s);
    const second = JSON.stringify(s.runs["user-a-run"].activities.map((a) => a.id));
    expect(second).toBe(first);
  });
});
