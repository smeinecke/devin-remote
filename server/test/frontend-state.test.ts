import { describe, it } from "node:test";
import assert from "node:assert";
import "./frontend-polyfill.js";
import { sendPrompt, getState, dispatchEvent } from "../../web/src/state.ts";
import { api } from "../../web/src/api.ts";
import type { SessionState } from "../../web/src/store-types.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  } as SessionState;
}

function agentErrors(state: SessionState) {
  return Object.values(state.messages).filter(
    (m: any) => m.role === "agent" && (m.text as string).startsWith("**Error:**"),
  );
}

describe("frontend state", () => {
  it("ignores a stale sendPrompt() error after a generation change", async () => {
    const sessionId = "s1";
    const state = getState();
    state.sessions[sessionId] = makeSession(sessionId, 1);

    let rejectA: ((reason?: unknown) => void) | null = null;
    const originalPrompt = api.prompt;
    api.prompt = () => new Promise((_resolve, reject) => {
      rejectA = reject;
    });

    const promptA = sendPrompt(sessionId, "first", []);
    await wait(10);
    assert.strictEqual(getState().sessions[sessionId].running, true);
    assert.ok(getState().sessions[sessionId].activePromptRequest, "expected active prompt request for A");

    // Simulate a server-side generation change.
    dispatchEvent({
      type: "generation_changed",
      sessionId,
      previousGeneration: 1,
      processGeneration: 2,
    } as any);
    await wait(10);

    // Start a new prompt B.
    api.prompt = () => Promise.resolve({} as any);
    const promptB = sendPrompt(sessionId, "second", []);
    await wait(10);

    // Reject the stale prompt A.
    api.prompt = originalPrompt;
    rejectA?.(new Error("stale generation"));
    await promptA;
    await wait(10);

    // Generation 2 should remain running and no error message should appear.
    assert.strictEqual(getState().sessions[sessionId].running, true);
    assert.strictEqual(agentErrors(getState().sessions[sessionId]).length, 0);

    await promptB;
  });

  it("ignores a stale sendPrompt() success after a generation change", async () => {
    const sessionId = "s2";
    const state = getState();
    state.sessions[sessionId] = makeSession(sessionId, 1);

    let resolveA: ((v: any) => void) | null = null;
    const originalPrompt = api.prompt;
    api.prompt = () => new Promise((resolve) => {
      resolveA = resolve;
    });

    const promptA = sendPrompt(sessionId, "first", []);
    await wait(10);

    dispatchEvent({
      type: "generation_changed",
      sessionId,
      previousGeneration: 1,
      processGeneration: 2,
    } as any);
    await wait(10);

    api.prompt = () => Promise.resolve({} as any);
    const promptB = sendPrompt(sessionId, "second", []);
    await wait(10);

    // Resolve the stale prompt A successfully.
    api.prompt = originalPrompt;
    resolveA?.({});
    await promptA;
    await wait(10);

    assert.strictEqual(getState().sessions[sessionId].running, true);
    assert.strictEqual(agentErrors(getState().sessions[sessionId]).length, 0);

    await promptB;
  });
});
