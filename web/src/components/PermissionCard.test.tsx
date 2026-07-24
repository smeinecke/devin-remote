import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { getState } from "../state";
import PermissionStack from "./PermissionCard";
import type { SessionState, SubagentDescriptor } from "../store-types";

function setSession(session: SessionState) {
  const state = getState();
  state.activeSessionId = session.sessionId;
  state.sessions[session.sessionId] = session;
}

function baseSession(sessionId: string): SessionState {
  return {
    sessionId,
    cwd: "/tmp",
    title: null,
    alias: null,
    branch: null,
    worktree: null,
    updatedAt: null,
    processGeneration: 1,
    status: "idle",
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
    running: false,
    cancellable: false,
    activeOperation: null,
    synced: true,
    unread: false,
    openAgentMsg: null,
    openThoughtMsg: null,
    openUserMsg: null,
    lastSequence: 0,
    activePromptRequest: null,
  };
}

function subagentDescriptor(id: string, overrides: Partial<SubagentDescriptor> = {}): SubagentDescriptor {
  return {
    id,
    sessionId: "s1",
    processGeneration: 1,
    parentSubagentId: null,
    parentToolCallId: null,
    title: `Subagent ${id.slice(0, 8)}`,
    prompt: null,
    status: "running",
    startedAt: Date.now(),
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

describe("PermissionStack", () => {
  beforeEach(() => {
    const state = getState();
    state.activeSessionId = null;
    state.sessions = {};
    cleanup();
  });

  it("renders a subagent title and an accessible label when subagentId is present", () => {
    const session = baseSession("s1");
    session.subagents = { "sub-a": subagentDescriptor("sub-a", { title: "Run backend tests" }) };
    session.permissions = [
      {
        requestId: "perm-1",
        subagentId: "sub-a",
        toolCall: { title: "Run command", rawInput: { command: "npm test" } },
        options: [{ optionId: "yes", name: "Allow", kind: "allow" }],
      },
    ];
    setSession(session);

    render(<PermissionStack />);
    expect(screen.getByText("Run backend tests")).not.toBeNull();
    expect(screen.getByText(/npm test/)).not.toBeNull();
    expect(screen.getByLabelText(/Subagent.*Run backend tests.*requests permission/i)).not.toBeNull();
  });

  it("falls back to the tool title when the subagent is unknown", () => {
    const session = baseSession("s1");
    session.permissions = [
      {
        requestId: "perm-1",
        subagentId: "missing",
        toolCall: { title: "Edit file", rawInput: { path: "/foo" } },
        options: [{ optionId: "yes", name: "Allow", kind: "allow" }],
      },
    ];
    setSession(session);

    render(<PermissionStack />);
    expect(screen.getByText(/Edit file/)).not.toBeNull();
  });

  it("renders nested ancestry for a nested subagent permission", () => {
    const session = baseSession("s1");
    session.subagents = {
      "parent-sub": subagentDescriptor("parent-sub", { title: "Backend review" }),
      child: subagentDescriptor("child", {
        title: "Run tests",
        parentSubagentId: "parent-sub",
      }),
    };
    session.permissions = [
      {
        requestId: "perm-1",
        subagentId: "child",
        toolCall: { title: "Run command" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow" }],
      },
    ];
    setSession(session);

    render(<PermissionStack />);
    expect(screen.getByText("Backend review › Run tests")).not.toBeNull();
    expect(screen.getByLabelText(/Subagent Backend review.*Run tests.*requests permission/i)).not.toBeNull();
  });
});
