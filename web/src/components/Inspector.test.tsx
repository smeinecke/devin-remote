import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ActivityItem } from "./Inspector";
import type { AgentActivity, SubagentDescriptor } from "../store-types";

function subagent(title: string, status: SubagentDescriptor["status"], overrides: Partial<SubagentDescriptor> = {}): SubagentDescriptor {
  return {
    id: `sub-${title}`,
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
    details: { subagent: subagent("Test subagent", "running") },
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
      details: { subagent: subagent("Failing subagent", "failed", { error: "Database connection refused" }) },
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
      details: { subagent: subagent("Approval subagent", "waiting_for_permission") },
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
        subagent: subagent("Done subagent", "completed", {
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
      details: { subagent: subagent("Parent", "running") },
      autoExpand: true,
      children: [child],
    });
    const { container } = render(<ActivityItem activity={act} />);
    const nested = container.querySelectorAll(".ml-2");
    expect(nested.length).toBeGreaterThan(0);
  });
});
