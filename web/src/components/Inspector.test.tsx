import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import Inspector, { ActivityItem } from "./Inspector";
import { getState } from "../state";
import { rebuildRuns } from "../runs";
import { createSubagentActivity } from "../activity";
import type { AgentActivity, SessionState, SubagentDescriptor, ToolCallState } from "../store-types";

function subagentDescriptor(title: string, status: SubagentDescriptor["status"], overrides: Partial<SubagentDescriptor> = {}): SubagentDescriptor {
  const { id = `sub-${title}`, ...rest } = overrides;
  return {
    id,
    sessionId: "s1",
    processGeneration: 1,
    parentSubagentId: null,
    parentToolCallId: null,
    title,
    prompt: null,
    status,
    startedAt: 0,
    completedAt: null,
    result: null,
    error: null,
    profile: null,
    depth: 1,
    isBackground: false,
    toolCallIds: [],
    pendingPermissions: [],
    ...rest,
  };
}

function toolCall(overrides: Partial<ToolCallState> & { id: string }): ToolCallState {
  return {
    title: overrides.title ?? `Tool ${overrides.id}`,
    kind: overrides.kind ?? "command",
    status: overrides.status ?? "completed",
    content: [],
    startedAt: overrides.startedAt ?? 0,
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
    cancellable: true,
    activeOperation: null,
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

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "act-1",
    type: "subagent",
    title: "Test subagent",
    status: "in_progress",
    startedAt: 0,
    details: { subagent: subagentDescriptor("Test subagent", "running") },
    children: [],
    ...overrides,
  };
}

describe("ActivityItem", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders a running subagent with title and status", () => {
    render(<ActivityItem activity={activity()} />);
    expect(screen.getByText("Test subagent")).not.toBeNull();
    expect(screen.getByText("Running")).not.toBeNull();
  });

  it("defaults to expanded for a failed subagent and shows its error", () => {
    const act = activity({
      title: "Failing subagent",
      details: { subagent: subagentDescriptor("Failing subagent", "failed", { error: "Database connection refused" }) },
      autoExpand: true,
    });
    render(<ActivityItem activity={act} />);
    expect(screen.getByText("Failing subagent")).not.toBeNull();
    expect(screen.getByText("Failed")).not.toBeNull();
    expect(screen.getByText("Database connection refused")).not.toBeNull();
  });

  it("shows permission counts for a waiting-for-approval subagent", () => {
    const act = activity({
      title: "Approval subagent",
      details: { subagent: subagentDescriptor("Approval subagent", "waiting_for_permission") },
      children: [{ id: "child-1", type: "permission", title: "Approve", status: "pending", startedAt: 0 }],
      autoExpand: true,
    });
    render(<ActivityItem activity={act} />);
    expect(screen.getByText("Waiting for approval")).not.toBeNull();
    expect(screen.getByText("1 permission")).not.toBeNull();
  });

  it("defaults to collapsed for a completed subagent", () => {
    const act = activity({
      title: "Done subagent",
      details: {
        subagent: subagentDescriptor("Done subagent", "completed", {
          result: "Done",
          completedAt: 10_000,
          startedAt: 0,
          prompt: "long prompt",
        }),
      },
      children: [
        { id: "c1", type: "file_read", title: "Read", status: "completed", startedAt: 0 },
        { id: "c2", type: "file_read", title: "Read", status: "completed", startedAt: 0 },
      ],
      autoExpand: false,
    });
    const { container } = render(<ActivityItem activity={act} />);
    expect(screen.getByText("Done subagent")).not.toBeNull();
    expect(screen.getByText("Completed")).not.toBeNull();
    expect(container.querySelector(".line-clamp-6")).toBeNull();
  });

  it("indents nested children with responsive classes", () => {
    const child: AgentActivity = {
      id: "child",
      type: "command",
      title: "nested",
      status: "completed",
      startedAt: 0,
    };
    const act = activity({
      title: "Parent",
      details: { subagent: subagentDescriptor("Parent", "running") },
      autoExpand: true,
      children: [child],
    });
    const { container } = render(<ActivityItem activity={act} />);
    const nested = container.querySelectorAll(".ml-2");
    expect(nested.length).toBeGreaterThan(0);
  });

  it("auto-expands when the subagent becomes failed if the user has not manually changed", () => {
    const running = activity({
      title: "X",
      status: "in_progress",
      details: { subagent: subagentDescriptor("X", "running") },
      autoExpand: false,
    });
    const { rerender } = render(<ActivityItem activity={running} />);
    expect(screen.queryByText("Database connection refused")).toBeNull();

    const failed = activity({
      title: "X",
      status: "failed",
      details: { subagent: subagentDescriptor("X", "failed", { error: "Database connection refused" }) },
      autoExpand: true,
    });
    rerender(<ActivityItem activity={failed} />);
    expect(screen.getByText("Database connection refused")).not.toBeNull();
  });

  it("does not auto-expand after the user manually collapsed the card", () => {
    const running = activity({
      title: "X",
      status: "in_progress",
      details: { subagent: subagentDescriptor("X", "running", { prompt: "do work" }) },
      autoExpand: false,
    });
    const { rerender, container } = render(<ActivityItem activity={running} />);
    const button = screen.getByRole("button");
    fireEvent.click(button); // expand
    expect(container.querySelector(".rotate-90")).not.toBeNull();
    fireEvent.click(button); // collapse manually
    expect(container.querySelector(".rotate-90")).toBeNull();

    const failed = activity({
      title: "X",
      status: "failed",
      details: { subagent: subagentDescriptor("X", "failed", { error: "Database connection refused", prompt: "do work" }) },
      autoExpand: true,
    });
    rerender(<ActivityItem activity={failed} />);
    expect(container.querySelector(".rotate-90")).toBeNull();
  });

  it("falls back to a compact prompt preview when the subagent has no title", () => {
    const sub = subagentDescriptor("", "running", { prompt: "npm test -- --runInBand" });
    const act = { ...createSubagentActivity(sub), autoExpand: false };
    render(<ActivityItem activity={act} />);
    expect(screen.getByText("npm test -- --runInBand")).not.toBeNull();
  });
});

describe("Inspector from normalized state", () => {
  beforeEach(() => {
    cleanup();
    const state = getState();
    state.activeSessionId = null;
    state.sessions = {};
  });

  afterEach(() => {
    cleanup();
  });

  function setActiveSession(sessionState: SessionState) {
    rebuildRuns(sessionState);
    const state = getState();
    state.sessions[sessionState.sessionId] = sessionState;
    state.activeSessionId = sessionState.sessionId;
    state.ui.inspectorTab = "activity";
  }

  it("renders a tool-less completed subagent without duplicating the spawn tool", () => {
    const s = session({
      subagents: {
        "sub-review": subagentDescriptor("Review backend tests", "completed", {
          id: "sub-review",
          parentToolCallId: "spawn-review",
          result: "All tests passed",
          completedAt: 15_000,
        }),
      },
      toolCalls: {
        "spawn-review": toolCall({ id: "spawn-review", title: "Run subagent", kind: "run_subagent" }),
      },
      timeline: [{ kind: "tool", id: "spawn-review" }],
    });
    setActiveSession(s);

    render(<Inspector />);
    expect(screen.getByText("Review backend tests")).not.toBeNull();
    expect(screen.getByText("Completed")).not.toBeNull();
    expect(screen.queryByText("Run subagent")).toBeNull();
    expect(screen.getByLabelText("Subagent: Review backend tests")).not.toBeNull();
  });

  it("renders a nested subagent with owned tools", () => {
    const s = session({
      subagents: {
        parent: subagentDescriptor("Parent", "running", {
          id: "parent",
          parentToolCallId: "spawn-parent",
          startedAt: 1000,
        }),
        child: subagentDescriptor("Child", "running", {
          id: "child",
          parentSubagentId: "parent",
          parentToolCallId: "spawn-child",
          toolCallIds: ["child-tool"],
          startedAt: 2000,
        }),
      },
      toolCalls: {
        "spawn-parent": toolCall({ id: "spawn-parent", title: "Run subagent" }),
        "spawn-child": toolCall({ id: "spawn-child", title: "Run subagent", subagentId: "parent" }),
        "child-tool": toolCall({ id: "child-tool", title: "Read state.ts", subagentId: "child" }),
      },
      timeline: [
        { kind: "tool", id: "spawn-parent" },
        { kind: "tool", id: "spawn-child" },
        { kind: "tool", id: "child-tool" },
      ],
    });
    setActiveSession(s);

    render(<Inspector />);
    expect(screen.getByText("Parent")).not.toBeNull();
    expect(screen.getByText("Child")).not.toBeNull();
    expect(screen.getByText("Read state.ts")).not.toBeNull();
  });

  it("expands a failed subagent by default and shows its error", () => {
    const s = session({
      subagents: {
        "sub-fail": subagentDescriptor("Inspect migration", "failed", {
          id: "sub-fail",
          parentToolCallId: "spawn-fail",
          error: "Database connection refused",
          completedAt: 12_000,
        }),
      },
      toolCalls: {
        "spawn-fail": toolCall({ id: "spawn-fail", title: "Run subagent" }),
      },
      timeline: [{ kind: "tool", id: "spawn-fail" }],
    });
    setActiveSession(s);

    render(<Inspector />);
    expect(screen.getByText("Inspect migration")).not.toBeNull();
    expect(screen.getByText("Failed")).not.toBeNull();
    expect(screen.getByText("Database connection refused")).not.toBeNull();
  });

  it("expands a permission-blocked subagent by default", () => {
    const s = session({
      subagents: {
        "sub-perm": subagentDescriptor("Run integration tests", "waiting_for_permission", {
          id: "sub-perm",
          parentToolCallId: "spawn-perm",
          prompt: "npm test",
          pendingPermissions: ["perm-1"],
        }),
      },
      toolCalls: {
        "spawn-perm": toolCall({ id: "spawn-perm", title: "Run subagent" }),
      },
      timeline: [{ kind: "tool", id: "spawn-perm" }],
    });
    setActiveSession(s);

    render(<Inspector />);
    expect(screen.getByText("Run integration tests")).not.toBeNull();
    expect(screen.getByText("Waiting for approval")).not.toBeNull();
    expect(screen.getByText("npm test")).not.toBeNull();
  });

  it("indents nested subagent cards on mobile", () => {
    const s = session({
      subagents: {
        parent: subagentDescriptor("Parent", "running", { id: "parent", parentToolCallId: "spawn-parent" }),
        child: subagentDescriptor("Child", "running", { id: "child", parentSubagentId: "parent", parentToolCallId: "spawn-child" }),
      },
      toolCalls: {
        "spawn-parent": toolCall({ id: "spawn-parent" }),
        "spawn-child": toolCall({ id: "spawn-child", subagentId: "parent" }),
      },
      timeline: [{ kind: "tool", id: "spawn-parent" }, { kind: "tool", id: "spawn-child" }],
    });
    setActiveSession(s);

    const { container } = render(<Inspector />);
    const nested = container.querySelectorAll(".ml-2");
    expect(nested.length).toBeGreaterThan(0);
  });

  it("does not leak a previous run's subagent or tools into the active run panel", () => {
    const s = session({
      status: "running",
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
        "spawn-a": toolCall({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
        "tool-a": toolCall({ id: "tool-a", title: "Read files", subagentId: "sub-a", startedAt: 3000 }),
      },
      subagents: {
        "sub-a": subagentDescriptor("First run subagent", "completed", {
          id: "sub-a",
          parentToolCallId: "spawn-a",
          toolCallIds: ["tool-a"],
          result: "Done",
          completedAt: 4000,
          startedAt: 2000,
        }),
      },
    });
    setActiveSession(s);

    const { container } = render(<Inspector />);
    expect(screen.queryByText("First run subagent")).toBeNull();
    expect(screen.queryByText("Read files")).toBeNull();
    expect(container.textContent).toContain("0 activities");
  });

  it("does not show a previous run's subagent in the active run panel", () => {
    const s = session({
      status: "running",
      timeline: [
        { kind: "message", id: "user-a" },
        { kind: "tool", id: "spawn-a" },
        { kind: "message", id: "user-b" },
      ],
      messages: {
        "user-a": { id: "user-a", role: "user", text: "first", attachments: [], streaming: false, ts: 1000 },
        "user-b": { id: "user-b", role: "user", text: "second", attachments: [], streaming: false, ts: 5000 },
      },
      toolCalls: {
        "spawn-a": toolCall({ id: "spawn-a", title: "Run subagent", kind: "run_subagent", startedAt: 2000 }),
      },
      subagents: {
        "sub-a": subagentDescriptor("First run subagent", "completed", {
          id: "sub-a",
          parentToolCallId: "spawn-a",
          result: "Done",
          completedAt: 3000,
          startedAt: 2000,
        }),
      },
    });
    setActiveSession(s);

    const { container } = render(<Inspector />);
    // The active (second) run has no tools/subagents, so it should not leak the first run's subagent.
    expect(screen.queryByText("First run subagent")).toBeNull();
    expect(container.textContent).toContain("0 activities");
  });
});
