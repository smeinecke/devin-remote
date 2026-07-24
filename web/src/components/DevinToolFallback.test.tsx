import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "react";
import { DevinToolFallback } from "./DevinToolFallback";
import { getState } from "../state";
import type { ToolCallState, SessionState } from "../store-types";

function makeSession(cwd: string, worktree: string | null = null): SessionState {
  return {
    sessionId: "s1",
    cwd,
    worktree,
    title: null,
    alias: null,
    branch: null,
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
  };
}

function mount(toolCallId: string, call: ToolCallState, session: SessionState) {
  const state = getState();
  state.activeSessionId = session.sessionId;
  state.sessions = { [session.sessionId]: { ...session, toolCalls: { [toolCallId]: call } } };
  const props = { toolCallId, toolName: "test", args: {} } as unknown as React.ComponentProps<typeof DevinToolFallback>;
  return render(<DevinToolFallback {...props} />);
}

describe("DevinToolFallback", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    const state = getState();
    state.activeSessionId = null;
    state.sessions = {};
  });

  it("displays the shell command for a command tool", () => {
    const call: ToolCallState = {
      id: "t1",
      title: "Ran command",
      kind: "execute",
      status: "completed",
      content: [],
      rawInput: { command: "npm test" },
      startedAt: 0,
      finishedAt: 1000,
    };
    mount("t1", call, makeSession("/workspace"));

    expect(screen.getByText("npm test")).not.toBeNull();
    expect(screen.queryByText("Ran command")).toBeNull();
  });

  it("displays a repository-relative path for a file edit", () => {
    const worktree = "/repo/.devin-remote/worktrees/new-abc123";
    const call: ToolCallState = {
      id: "t2",
      title: "Edited file",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff" as const, path: `${worktree}/web/src/state.ts`, oldText: "", newText: "" }],
      rawInput: { path: `${worktree}/web/src/state.ts` },
      startedAt: 0,
      finishedAt: 1000,
    };
    mount("t2", call, makeSession("/repo/.devin-remote/worktrees/new-abc123", worktree));

    expect(screen.getByText("web/src/state.ts")).not.toBeNull();
    expect(screen.queryByText(/\.devin-remote\/worktrees/)).toBeNull();
  });

  it("keeps long rows inside a truncating container", () => {
    const call: ToolCallState = {
      id: "t3",
      title: "Ran command",
      kind: "execute",
      status: "completed",
      content: [],
      rawInput: { command: "node scripts/very-long-path-that-should-not-break-layout.js" },
      startedAt: 0,
      finishedAt: 1000,
    };
    const { container } = mount("t3", call, makeSession("/workspace"));

    const button = container.querySelector("button");
    expect(button?.classList.contains("min-w-0")).toBe(true);
    const title = container.querySelector(".truncate");
    expect(title?.classList.contains("min-w-0")).toBe(true);
  });
});
