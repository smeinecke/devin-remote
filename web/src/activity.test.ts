import { describe, it, expect } from "vitest";
import { buildRunActivities, createSubagentActivity, createToolActivity } from "./activity";
import type { SessionState, SubagentDescriptor, ToolCallState } from "./store-types";

function subagent(overrides: Partial<SubagentDescriptor> & { id: string }): SubagentDescriptor {
  return {
    sessionId: "s1",
    processGeneration: 1,
    parentSubagentId: null,
    parentToolCallId: null,
    title: `Subagent ${overrides.id}`,
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

describe("buildRunActivities", () => {
  it("renders a subagent with no tools", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1", toolCallIds: [] }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1", title: "Run subagent", kind: "run_subagent" }) },
    });
    const acts = buildRunActivities(["spawn-1"], s);
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("subagent");
    expect(acts[0].id).toBe("sub-a");
  });

  it("attaches an owned tool to its subagent", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", toolCallIds: ["tool-1"] }) },
      toolCalls: { "tool-1": tool({ id: "tool-1", subagentId: "sub-a" }) },
    });
    const acts = buildRunActivities(["tool-1"], s);
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
    const acts = buildRunActivities(["spawn-a", "tool-a", "spawn-b", "tool-b"], s);
    expect(acts).toHaveLength(2);
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
        "spawn-parent": tool({ id: "spawn-parent", title: "Run subagent" }),
        "spawn-child": tool({ id: "spawn-child", title: "Run subagent", subagentId: "parent" }),
        "child-tool": tool({ id: "child-tool", subagentId: "child" }),
      },
    });
    const acts = buildRunActivities(["spawn-parent", "spawn-child", "child-tool"], s);
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("parent");
    expect(acts[0].children).toHaveLength(1);
    expect(acts[0].children![0].id).toBe("child");
    expect(acts[0].children![0].children![0].id).toBe("child-tool");
  });

  it("supports three-level nesting", () => {
    const s = session({
      subagents: {
        a: subagent({ id: "a", parentToolCallId: "spawn-a" }),
        b: subagent({ id: "b", parentSubagentId: "a", parentToolCallId: "spawn-b" }),
        c: subagent({ id: "c", parentSubagentId: "b", parentToolCallId: "spawn-c", toolCallIds: ["tool-c"] }),
      },
      toolCalls: {
        "spawn-a": tool({ id: "spawn-a" }),
        "spawn-b": tool({ id: "spawn-b", subagentId: "a" }),
        "spawn-c": tool({ id: "spawn-c", subagentId: "b" }),
        "tool-c": tool({ id: "tool-c", subagentId: "c" }),
      },
    });
    const acts = buildRunActivities(["spawn-a", "spawn-b", "spawn-c", "tool-c"], s);
    const a = acts[0];
    const b = a.children![0];
    const c = b.children![0];
    expect(a.id).toBe("a");
    expect(b.id).toBe("b");
    expect(c.id).toBe("c");
    expect(c.children![0].id).toBe("tool-c");
  });

  it("renders a missing parent as a root orphan", () => {
    const s = session({
      subagents: { orphan: subagent({ id: "orphan", parentSubagentId: "missing", toolCallIds: ["tool-1"] }) },
      toolCalls: { "tool-1": tool({ id: "tool-1", subagentId: "orphan" }) },
    });
    const acts = buildRunActivities(["tool-1"], s);
    expect(acts).toHaveLength(1);
    expect(acts[0].id).toBe("orphan");
  });

  it("does not recurse infinitely on a self-cycle", () => {
    const s = session({
      subagents: { a: subagent({ id: "a", parentSubagentId: "a", toolCallIds: [] }) },
    });
    const acts = buildRunActivities([], s);
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
    const acts = buildRunActivities([], s);
    expect(acts.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(acts.map((a) => a.id));
    expect(ids.has("a") || ids.has("b")).toBe(true);
  });

  it("suppresses the spawning run_subagent tool", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1" }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1", title: "Run subagent", kind: "run_subagent" }) },
    });
    const acts = buildRunActivities(["spawn-1"], s);
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("subagent");
    expect(acts.every((a) => a.id !== "spawn-1")).toBe(true);
  });

  it("keeps unrelated main-agent tools visible", () => {
    const s = session({
      toolCalls: { "tool-1": tool({ id: "tool-1" }) },
    });
    const acts = buildRunActivities(["tool-1"], s);
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("command");
    expect(acts[0].id).toBe("tool-1");
  });

  it("restores the same tree from snapshot descriptors", () => {
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
    const acts = buildRunActivities(["spawn-parent", "spawn-child", "child-tool"], s);
    expect(acts[0].children![0].children![0].id).toBe("child-tool");
  });

  it("does not duplicate activity entries for duplicate descriptor updates", () => {
    const s = session({
      subagents: { "sub-a": subagent({ id: "sub-a", parentToolCallId: "spawn-1" }) },
      toolCalls: { "spawn-1": tool({ id: "spawn-1" }) },
    });
    const acts1 = buildRunActivities(["spawn-1"], s);
    const acts2 = buildRunActivities(["spawn-1"], s);
    expect(acts1).toHaveLength(1);
    expect(acts2).toHaveLength(1);
  });

  it("orders top-level subagents by startedAt", () => {
    const s = session({
      subagents: {
        second: subagent({ id: "second", startedAt: 2000 }),
        first: subagent({ id: "first", startedAt: 1000 }),
      },
    });
    const acts = buildRunActivities([], s);
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
    const acts = buildRunActivities(["spawn-a", "spawn-b"], s);
    expect(acts).toHaveLength(2);
    expect(new Set(acts.map((a) => a.id))).toEqual(new Set(["a", "b"]));
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
  it("sets autoExpand for a failed subagent", () => {
    const s = subagent({ id: "a", status: "failed", error: "Database connection refused" });
    const act = createSubagentActivity(s);
    expect(act.type).toBe("subagent");
    expect(act.autoExpand).toBe(true);
  });
});
