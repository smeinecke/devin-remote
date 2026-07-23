import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SubagentRegistry } from "../src/subagents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "subagents", "subagent-trace.jsonl");

async function loadTrace(): Promise<Record<string, unknown>[]> {
  const text = await readFile(fixturePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function payloadFromTrace(trace: Record<string, unknown>[]): Record<string, unknown>[] {
  return trace
    .filter((t) => t.kind === "session_update")
    .map((t) => (t.payload as { update?: Record<string, unknown> }).update ?? (t.payload as Record<string, unknown>));
}

describe("SubagentRegistry", () => {
  it("reconstructs the two repo subagents from the captured fixture", async () => {
    const updates = payloadFromTrace(await loadTrace());
    const registry = new SubagentRegistry("new-mrxfeb0x", 1);
    for (const u of updates) {
      registry.processUpdate(u);
    }

    const subagents = registry.list();
    assert.equal(subagents.length, 2);

    const tsSubagent = subagents.find((s) => s.title?.toLowerCase().includes(".ts"));
    const readmeSubagent = subagents.find((s) => s.title?.toLowerCase().includes("readme"));

    assert.ok(tsSubagent, "expected .ts listing subagent");
    assert.ok(readmeSubagent, "expected README summarization subagent");

    assert.equal(tsSubagent.status, "completed");
    assert.equal(readmeSubagent.status, "completed");

    assert.equal(tsSubagent.profile, "Explore");
    assert.equal(readmeSubagent.profile, "Explore");

    assert.equal(tsSubagent.isBackground, true);
    assert.equal(readmeSubagent.isBackground, true);

    assert.ok(tsSubagent.prompt?.includes("list all .ts files"));
    assert.ok(readmeSubagent.prompt?.includes("README.md"));

    assert.ok(tsSubagent.result?.includes("68"));
    assert.ok(readmeSubagent.result?.includes("Devin Remote"));

    assert.ok(tsSubagent.toolCallIds.length > 0, "expected at least one child tool call for .ts subagent");
    assert.ok(readmeSubagent.toolCallIds.length > 0, "expected at least one child tool call for README subagent");

    assert.ok(tsSubagent.parentToolCallId?.startsWith("functions.run_subagent"));
    assert.ok(readmeSubagent.parentToolCallId?.startsWith("functions.run_subagent"));
  });
});

function runSubagentToolCall(toolCallId: string, task: string, title: string, profile = "subagent_explore") {
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: `Ran explore subagent ${title}`,
    rawInput: { title, task, profile, is_background: true },
    _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
  };
}

function subagentStartedUpdate(
  agentId: string,
  toolCallId: string,
  title: string,
  task: string,
  profile = "Explore",
) {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
    _meta: {
      "cognition.ai/subagent_started": {
        agentId,
        title,
        task,
        profile,
        depth: 1,
        isBackground: true,
      },
    },
  };
}

function subagentCompletedUpdate(agentId: string, toolCallId: string, success: boolean, summary: string) {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    _meta: {
      "cognition.ai/subagent_completed": { agentId, success, summary, depth: 1 },
    },
  };
}

describe("SubagentRegistry permissions", () => {
  it("clears the matching subagent permission on manual approval", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    const started = registry.addPendingPermission("a1", "perm-1");
    assert.ok(started);

    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.ok(resolved);
    assert.equal(resolved?.patch.pendingPermissions?.length, 0);
    assert.equal(resolved?.patch.status, "running");
  });

  it("clears the matching subagent permission on manual rejection", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.addPendingPermission("a1", "perm-1");

    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.ok(resolved);
    assert.deepEqual(resolved?.patch.pendingPermissions, []);
  });

  it("keeps a subagent waiting when only one of several permissions resolves", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.addPendingPermission("a1", "perm-1");
    registry.addPendingPermission("a1", "perm-2");

    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.ok(resolved);
    assert.equal(resolved?.patch.pendingPermissions?.length, 1);
    assert.equal(resolved?.patch.status, "waiting_for_permission");
  });

  it("returns a non-terminal subagent to running when the last permission resolves", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.addPendingPermission("a1", "perm-1");
    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.equal(resolved?.patch.status, "running");
  });

  it("keeps a completed subagent completed after permission resolution", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.processUpdate(subagentCompletedUpdate("a1", "a1", true, "done"));
    registry.addPendingPermission("a1", "perm-1");

    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.ok(resolved);
    assert.equal(resolved?.patch.status, "completed");
  });

  it("keeps a failed subagent failed after permission resolution", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.processUpdate(subagentCompletedUpdate("a1", "a1", false, "Database connection refused"));
    registry.addPendingPermission("a1", "perm-1");

    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.equal(resolved?.patch.status, "failed");
  });

  it("keeps a cancelled subagent cancelled", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.processUpdate(subagentCompletedUpdate("a1", "a1", false, "cancelled by user"));
    assert.equal(registry.get("a1")?.status, "cancelled");

    registry.addPendingPermission("a1", "perm-1");
    const resolved = registry.resolvePermission("a1", "perm-1");
    assert.equal(resolved?.patch.status, "cancelled");
  });

  it("is idempotent for duplicate permission resolution", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.addPendingPermission("a1", "perm-1");
    registry.resolvePermission("a1", "perm-1");

    const duplicate = registry.resolvePermission("a1", "perm-1");
    assert.equal(duplicate, null);
  });
});

describe("SubagentRegistry spawn correlation", () => {
  it("correlates two identical concurrent tasks to different tool calls in FIFO order", () => {
    const registry = new SubagentRegistry("s1", 1);
    const task = "list all files";
    registry.processUpdate(runSubagentToolCall("functions.run_subagent:0", task, "Task A"));
    registry.processUpdate(runSubagentToolCall("functions.run_subagent:1", task, "Task B"));

    registry.processUpdate(subagentStartedUpdate("agent-a", "agent-a", "Task A", task));
    registry.processUpdate(subagentStartedUpdate("agent-b", "agent-b", "Task B", task));

    const a = registry.get("agent-a");
    const b = registry.get("agent-b");
    assert.equal(a?.parentToolCallId, "functions.run_subagent:0");
    assert.equal(b?.parentToolCallId, "functions.run_subagent:1");
  });

  it("removes pending spawn correlation when the spawning tool fails", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(runSubagentToolCall("functions.run_subagent:0", "list files", "List"));
    registry.processUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "functions.run_subagent:0",
      status: "failed",
      _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
    });

    registry.processUpdate(subagentStartedUpdate("agent-a", "agent-a", "List", "list files"));
    const a = registry.get("agent-a");
    assert.equal(a?.parentToolCallId, null);
  });

  it("does not duplicate tool-call ids on repeated start events", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(runSubagentToolCall("functions.run_subagent:0", "list files", "List"));
    const start = subagentStartedUpdate("agent-a", "agent-a", "List", "list files");
    registry.processUpdate(start);
    registry.processUpdate(start);

    const a = registry.get("agent-a")!;
    assert.equal(a.toolCallIds.length, 1);
    assert.equal(a.toolCallIds[0], "agent-a");
  });

  it("sets completedAt on read_subagent fallback completion", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("agent-a", "agent-a", "List", "list files"));
    registry.processUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "functions.read_subagent:0",
      status: "completed",
      rawInput: { agent_id: "agent-a", block: true, timeout: 60 },
      content: [{ content: { text: "68 files found", type: "text" }, type: "content" }],
      _meta: { "cognition.ai/inferenceToolName": "read_subagent" },
    });

    const a = registry.get("agent-a")!;
    assert.equal(a.status, "completed");
    assert.ok(a.completedAt && a.completedAt > 0);
    assert.ok(a.result?.includes("68 files found"));
  });

  it("expires unmatched pending spawns after the TTL", () => {
    const originalNow = Date.now;
    const times: number[] = [0];
    Date.now = () => times[times.length - 1];

    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(runSubagentToolCall("functions.run_subagent:0", "list files", "List"));

    // Advance past the TTL.
    times[0] = 61_000;
    registry.processUpdate(subagentStartedUpdate("agent-a", "agent-a", "List", "list files"));

    const a = registry.get("agent-a")!;
    assert.equal(a.parentToolCallId, null);

    Date.now = originalNow;
  });
});

describe("SubagentRegistry generation isolation", () => {
  it("rejects old-generation events by replacing the registry for a new generation", () => {
    const oldRegistry = new SubagentRegistry("s1", 1);
    oldRegistry.processUpdate(subagentStartedUpdate("a1", "a1", "Run", "run"));
    assert.equal(oldRegistry.get("a1")?.status, "running");

    const newRegistry = new SubagentRegistry("s1", 2);
    newRegistry.processUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "a1",
      status: "completed",
      _meta: { "cognition.ai/subagent_completed": { agentId: "a1", success: true, summary: "done" } },
    });

    // The new registry should not inherit the old one's subagents.
    assert.equal(oldRegistry.get("a1")?.status, "running");
    assert.equal(newRegistry.get("a1")?.status, "completed");
  });
});

describe("SubagentRegistry snapshot", () => {
  it("preserves permission ownership across a snapshot round-trip", () => {
    const registry = new SubagentRegistry("s1", 1);
    registry.processUpdate(subagentStartedUpdate("a1", "a1", "Run tests", "npm test"));
    registry.addPendingPermission("a1", "perm-1");

    const snapshot = registry.snapshot();
    assert.equal(snapshot.a1.pendingPermissions.length, 1);
    assert.equal(snapshot.a1.pendingPermissions[0], "perm-1");
    assert.equal(snapshot.a1.status, "waiting_for_permission");
  });
});
