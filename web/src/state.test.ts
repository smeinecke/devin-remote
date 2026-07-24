import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { api } from "./api";
import { getState, dispatchEvent, selectSession, cancelPrompt } from "./state";
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
        cancellable: true,
        activeOperation: { kind: "prompt", id: "op-1", processGeneration: 1 },
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

  it("merges a subagent result backfill via subagent_updated", () => {
    const session = makeSession("s1", 1);
    session.subagents = {
      "sub-a": {
        id: "sub-a",
        sessionId: "s1",
        processGeneration: 1,
        parentSubagentId: null,
        parentToolCallId: null,
        title: "List files",
        prompt: "list files",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: null,
        error: null,
        profile: null,
        depth: 1,
        isBackground: false,
        toolCallIds: [],
        pendingPermissions: [],
      } satisfies SubagentDescriptor,
    };
    setSession(session);

    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "subagent_updated",
      payload: { subagentId: "sub-a", patch: { result: "68 files found" } },
    });

    const s = getState().sessions.s1;
    expect(s.subagents["sub-a"].result).toBe("68 files found");
    expect(s.subagents["sub-a"].completedAt).toBe(2000);
    expect(s.subagents["sub-a"].error).toBeNull();
  });

  it("repeats of the same subagent_updated backfill are idempotent", () => {
    const session = makeSession("s1", 1);
    session.subagents = {
      "sub-a": {
        id: "sub-a",
        sessionId: "s1",
        processGeneration: 1,
        parentSubagentId: null,
        parentToolCallId: null,
        title: "List files",
        prompt: "list files",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: null,
        error: null,
        profile: null,
        depth: 1,
        isBackground: false,
        toolCallIds: [],
        pendingPermissions: [],
      } satisfies SubagentDescriptor,
    };
    setSession(session);

    const backfill = {
      type: "event" as const,
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "subagent_updated",
      payload: { subagentId: "sub-a", patch: { result: "68 files found" } },
    };

    dispatchEvent(backfill);
    expect(getState().sessions.s1.subagents["sub-a"].result).toBe("68 files found");
    expect(getState().sessions.s1.subagents["sub-a"].completedAt).toBe(2000);

    dispatchEvent({ ...backfill, sequence: 2 });
    expect(getState().sessions.s1.subagents["sub-a"].result).toBe("68 files found");
    expect(getState().sessions.s1.subagents["sub-a"].completedAt).toBe(2000);
  });

  it("does not overwrite a completed subagent result with a conflicting failure event", () => {
    const session = makeSession("s1", 1);
    session.subagents = {
      "sub-a": {
        id: "sub-a",
        sessionId: "s1",
        processGeneration: 1,
        parentSubagentId: null,
        parentToolCallId: null,
        title: "List files",
        prompt: "list files",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
        error: null,
        profile: null,
        depth: 1,
        isBackground: false,
        toolCallIds: [],
        pendingPermissions: [],
      } satisfies SubagentDescriptor,
    };
    setSession(session);

    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "subagent_failed",
      payload: { subagentId: "sub-a", error: "Database connection refused", completedAt: 3000 },
    });

    const s = getState().sessions.s1;
    expect(s.subagents["sub-a"].status).toBe("completed");
    expect(s.subagents["sub-a"].result).toBe("done");
    expect(s.subagents["sub-a"].error).toBeNull();
  });

  it("stores a subagent from a server subagent_started envelope", () => {
    const session = makeSession("s1", 1);
    setSession(session);

    const subagent: SubagentDescriptor = {
      id: "sub-a",
      sessionId: "s1",
      processGeneration: 1,
      parentSubagentId: null,
      parentToolCallId: null,
      title: "List files",
      prompt: "list files",
      status: "running",
      startedAt: 1000,
      completedAt: null,
      result: null,
      error: null,
      profile: null,
      depth: 1,
      isBackground: false,
      toolCallIds: ["tc-1"],
      pendingPermissions: [],
    };

    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "subagent_started",
      payload: { type: "subagent_started", subagent },
    });

    const s = getState().sessions.s1;
    expect(s.subagents["sub-a"].title).toBe("List files");
    expect(s.subagents["sub-a"].status).toBe("running");
    expect(s.subagents["sub-a"].toolCallIds).toContain("tc-1");
  });
});

describe("lifecycle state reconstruction", () => {
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

  function contentEvent(sessionId: string, update: Record<string, unknown>) {
    return {
      type: "event" as const,
      sessionId,
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "session_update" as const,
      payload: update,
    };
  }

  it("does not set running=true from a historical agent message chunk", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent(contentEvent("s1", { sessionUpdate: "agent_message_chunk", content: { text: "hello" } }));
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
  });

  it("does not set running=true from a historical thought chunk", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent(contentEvent("s1", { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } }));
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
  });

  it("does not set running=true from a historical tool_call", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent(contentEvent("s1", { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "ls", kind: "bash", status: "in_progress" }));
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
  });

  it("does not set running=true from a historical plan event", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent(contentEvent("s1", { sessionUpdate: "plan", entries: [{ content: "step 1", status: "in_progress" }] }));
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
  });

  it("sets running and cancellable on prompt_started", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "prompt_started",
      payload: { operationId: "op-1", processGeneration: 1, status: "running", cancellable: true },
    });
    const s = getState().sessions.s1;
    expect(s.running).toBe(true);
    expect(s.cancellable).toBe(true);
    expect(s.activeOperation).toEqual({ kind: "prompt", id: "op-1", processGeneration: 1 });
  });

  it("clears running and cancellable on prompt_done", () => {
    setSession(makeSession("s1", 1));
    getState().sessions.s1.running = true;
    getState().sessions.s1.cancellable = true;
    getState().sessions.s1.activeOperation = { kind: "prompt", id: "op-1", processGeneration: 1 };
    dispatchEvent({
      type: "event",
      sessionId: "s1",
      processGeneration: 1,
      sequence: 1,
      timestamp: Date.now(),
      eventType: "prompt_done",
      payload: { result: { stopReason: "end_turn" } },
    });
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
    expect(s.activeOperation).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("keeps snapshot running=false after replaying historical content events", () => {
    setSession(makeSession("s1", 1));
    dispatchEvent({
      type: "snapshot",
      sessionId: "s1",
      processGeneration: 1,
      timestamp: Date.now(),
      complete: false,
      baseSequence: null,
      latestSequence: 2,
      state: {
        sessionId: "s1",
        processGeneration: 1,
        status: "idle",
        cwd: "/tmp",
        pendingPermissions: [],
        running: false,
        cancellable: false,
        activeOperation: null,
        latestSequence: 2,
      },
      events: [
        contentEvent("s1", { sessionUpdate: "agent_message_chunk", content: { text: "old" } }),
      ],
    });
    const s = getState().sessions.s1;
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
    expect(s.activeOperation).toBeNull();
    expect(s.messages[Object.keys(s.messages)[0]]?.text).toBe("old");
  });

  it("clears stale running when opening an idle existing session", async () => {
    const session = makeSession("s1", 1);
    session.running = true;
    session.cancellable = true;
    session.status = "running";
    session.synced = false;
    session.activeOperation = { kind: "prompt", id: "op-1", processGeneration: 1 };
    setSession(session);

    const original = api.openSession;
    api.openSession = () =>
      Promise.resolve({
        ok: true,
        status: "idle",
        processGeneration: 1,
        sessionId: "s1",
        branch: null,
        worktree: null,
        running: false,
        cancellable: false,
        activeOperation: null,
      });
    await selectSession("s1");
    api.openSession = original;

    const s = getState().sessions.s1;
    expect(s.status).toBe("idle");
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
    expect(s.activeOperation).toBeNull();
  });

  it("reconciles a NO_ACTIVE_PROMPT cancel response without adding a chat error", async () => {
    const session = makeSession("s1", 1);
    session.running = true;
    session.cancellable = true;
    session.status = "running";
    session.activeOperation = { kind: "prompt", id: "op-1", processGeneration: 1 };
    setSession(session);

    const original = api.cancel;
    api.cancel = () =>
      Promise.resolve({
        ok: false,
        error: { code: "NO_ACTIVE_PROMPT", message: "No prompt is currently running." },
        state: {
          sessionId: "s1",
          processGeneration: 1,
          status: "idle",
          cwd: "/tmp",
          pendingPermissions: [],
          running: false,
          cancellable: false,
          activeOperation: null,
          latestSequence: 0,
        },
      });
    await cancelPrompt("s1");
    api.cancel = original;

    const s = getState().sessions.s1;
    expect(s.status).toBe("idle");
    expect(s.running).toBe(false);
    expect(s.cancellable).toBe(false);
    expect(s.activeOperation).toBeNull();
    const errorMessages = Object.values(s.messages).filter((m) => m.text.startsWith("**Error:**"));
    expect(errorMessages.length).toBe(0);
  });
});
