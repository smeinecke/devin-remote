import { describe, it } from "node:test";
import assert from "node:assert";
import "./frontend-polyfill.js";
import { sendPrompt, getState } from "../../web/src/state.ts";
import { api } from "../../web/src/api.ts";
import type { SessionState } from "../../web/src/store-types.ts";

describe("frontend state", () => {
  it("ignores a stale sendPrompt() response after a generation change", async () => {
    const sessionId = "s1";
    const state = getState();
    state.sessions[sessionId] = {
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
    } as SessionState;

    let resolveA: ((v: any) => void) | null = null;
    const originalPrompt = api.prompt;
    api.prompt = () => new Promise((resolve) => {
      resolveA = resolve;
    });

    const promptA = sendPrompt(sessionId, "first", []);
    // Drain the requestAnimationFrame queue so setState effects settle.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(getState().sessions[sessionId].running, true);
    const firstToken = getState().sessions[sessionId].activePromptRequest;
    assert.ok(firstToken, "expected active prompt request for A");

    // Simulate a generation change (e.g. server restart / replacement).
    state.sessions[sessionId].processGeneration = 2;
    state.sessions[sessionId].activePromptRequest = null;

    // Start a new prompt B.
    api.prompt = () => Promise.resolve({} as any);
    const promptB = sendPrompt(sessionId, "second", []);
    await new Promise((r) => setTimeout(r, 10));

    // Resolve the stale prompt A with an error.
    api.prompt = originalPrompt;
    resolveA?.({ error: "stale" });
    await promptA;
    await new Promise((r) => setTimeout(r, 10));

    // Generation 2 should remain running and the error must not be added.
    assert.strictEqual(getState().sessions[sessionId].running, true);
    const agentErrors = Object.values(getState().sessions[sessionId].messages).filter(
      (m: any) => m.role === "agent" && (m.text as string).startsWith("**Error:**"),
    );
    assert.strictEqual(agentErrors.length, 0);

    await promptB;
  });
});
