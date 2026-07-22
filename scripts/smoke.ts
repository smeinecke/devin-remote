/**
 * End-to-end smoke test against a real `devin acp` process.
 *
 *   npm run smoke
 *
 * Creates two sessions in a temp dir, runs a tiny prompt in each, and verifies
 * that each session has its own ACP process (no shared workspace process).
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SessionRegistry } from "../server/src/session-registry.js";

const base = path.join(os.tmpdir(), "devin-remote-smoke-v2");
await fs.mkdir(base, { recursive: true });

const registry = new SessionRegistry({
  onEvent: (sessionId, envelope) => {
    if (envelope.type !== "event") return;
    const ev = envelope as { eventType: string; payload: Record<string, unknown> };
    const u = ev.payload as { sessionUpdate?: string };
    const brief =
      u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk"
        ? JSON.stringify((u as { content?: { text?: string } }).content?.text ?? "").slice(0, 80)
        : u.sessionUpdate === "usage_update"
          ? `used=${u.used} size=${u.size}`
          : "";
    console.log(`  [${sessionId}] ${u.sessionUpdate ?? ev.eventType} ${brief}`);
  },
});

async function createAndPrompt(cwd: string, text: string) {
  const { sessionId } = await registry.create(cwd);
  console.log(`[smoke] created ${sessionId} in ${cwd}`);
  await registry.attach(sessionId, cwd);
  const controller = registry.get(sessionId)!;
  const done = await controller.prompt([{ type: "text", text }]);
  console.log(`[smoke] ${sessionId} finished:`, JSON.stringify(done));
  return { sessionId, controller };
}

const dirA = path.join(base, "a");
const dirB = path.join(base, "b");
await fs.mkdir(dirA, { recursive: true });
await fs.mkdir(dirB, { recursive: true });

console.log(`[smoke] starting session A in ${dirA}`);
const a = await createAndPrompt(dirA, "Reply with exactly: OK-A");

console.log(`[smoke] starting session B in ${dirB}`);
const b = await createAndPrompt(dirB, "Reply with exactly: OK-B");

const acpA = a.controller.getAcp();
const acpB = b.controller.getAcp();

if (acpA && acpB && acpA.processId !== acpB.processId) {
  console.log("[smoke] each session has a separate ACP process ✓");
} else {
  console.error("[smoke] sessions share an ACP process!");
  process.exitCode = 1;
}

registry.killAll();
console.log("[smoke] OK");
process.exit(0);
