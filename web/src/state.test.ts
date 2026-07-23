import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getState, dispatchEvent } from "./state";
import type { SessionState, SubagentDescriptor } from "./store-types";

function makeSession(sessionId: string, processGeneration: number): SessionState {
  return {
    sessionId,
    cwd: "/tmp",
    title: null,
    alias: null,
    branch: null,
    worktree: null,
    updatedAt: null,
    processGeneration,
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
    synced: true,
    unread: false,
    openAgentMsg: null,
    openThoughtMsg: null,
    openUserMsg: null,
    lastSequence: 0,
    activePromptRequest: null,
  };
}

function setSession(session: SessionState) {
  const state = getState();
  state.activeSessionId = session.sessionId;
  state.sessions[session.sessionId] = session;
}

describe("frontend subagent + permission state", () => {
  beforeEach(() => {
    const state = getState();
    state.activeSessionId = null;
    state.sessions = {};
  });

  afterEach(() => {
    const state = getState();
    state.activeSessionId = null;
    state.sessions = {};
  });

  it("retains subagentId on a permission_request event", () => {
    const session = makeSession("s1", 1);
    setSession(session);

    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "permission_request",
      payload: {
        requestId: "perm-1",
        sessionId: "s1",
        subagentId: "sub-a",
        toolCall: { title: "Run command", rawInput: { command: "npm test" } },
        options: [{ optionId: "yes", name: "Allow", kind: "allow" }],
      },
    });

    const perm = getState().sessions.s1.permissions[0];
    expect(perm.requestId).toBe("perm-1");
    expect(perm.subagentId).toBe("sub-a");
  });

  it("removes only the resolved permission", () => {
    const session = makeSession("s1", 1);
    session.permissions = [
      { requestId: "perm-1", subagentId: "sub-a", toolCall: {}, options: [] },
      { requestId: "perm-2", subagentId: "sub-b", toolCall: {}, options: [] },
    ];
    setSession(session);

    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "permission_resolved",
      payload: { requestId: "perm-1", subagentId: "sub-a" },
    });

    const perms = getState().sessions.s1.permissions;
    expect(perms.length).toBe(1);
    expect(perms[0].requestId).toBe("perm-2");
  });

  it("preserves permission attribution through a snapshot merge", () => {
    const session = makeSession("s1", 1);
    session.subagents = {
      "sub-a": {
        id: "sub-a",
        sessionId: "s1",
        processGeneration: 1,
        parentSubagentId: null,
        parentToolCallId: null,
        title: "Run tests",
        prompt: "npm test",
        status: "waiting_for_permission",
        startedAt: Date.now(),
        completedAt: null,
        result: null,
        error: null,
        profile: null,
        depth: 1,
        isBackground: false,
        toolCallIds: [],
        pendingPermissions: ["perm-1"],
      } satisfies SubagentDescriptor,
    };
    setSession(session);

    dispatchEvent({
      type: "snapshot",
      sessionId: "s1",
      processGeneration: 1,
      timestamp: Date.now(),
      complete: false,
      baseSequence: null,
      latestSequence: 1,
      state: {
        sessionId: "s1",
        processGeneration: 1,
        status: "waiting_for_permission",
        cwd: "/tmp",
        pendingPermissions: [{ requestId: "perm-1", subagentId: "sub-a", toolCall: {}, options: [] }],
        running: true,
        latestSequence: 1,
      },
      events: [],
    });

    const s = getState().sessions.s1;
    expect(s.subagents["sub-a"].pendingPermissions).toEqual(["perm-1"]);
    expect(s.permissions[0].subagentId).toBe("sub-a");
  });

  it("clears obsolete live permissions on a generation change", () => {
    const session = makeSession("s1", 1);
    session.permissions = [{ requestId: "perm-1", subagentId: "sub-a", toolCall: {}, options: [] }];
    setSession(session);

    dispatchEvent({
      type: "generation_changed",
      sessionId: "s1",
      previousGeneration: 1,
      processGeneration: 2,
    });

    const s = getState().sessions.s1;
    expect(s.processGeneration).toBe(2);
    expect(s.permissions).toEqual([]);
  });
});
