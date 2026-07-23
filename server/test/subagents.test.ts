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
