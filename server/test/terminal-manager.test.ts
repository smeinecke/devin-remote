import { describe, it } from "node:test";
import assert from "node:assert";
import { TerminalManager } from "../src/terminal-manager.js";

describe("TerminalManager", () => {
  it("creates terminals scoped by session and generation", () => {
    const tm = new TerminalManager();
    const out: string[] = [];
    const h = tm.create(
      {
        sessionId: "s1",
        processGeneration: 1,
        command: "echo",
        args: ["hello"],
        env: process.env,
      },
      {
        onOutput: (handle, data) => out.push(`${handle.terminalId}:${data.trim()}`),
        onExit: () => {},
      },
    );
    assert.strictEqual(h.sessionId, "s1");
    assert.strictEqual(h.processGeneration, 1);
    assert.strictEqual(h.status, "running");
  });

  it("filters get by session and generation", () => {
    const tm = new TerminalManager();
    const h1 = tm.create(
      { sessionId: "s1", processGeneration: 1, command: "sleep", args: ["10"], env: process.env },
      { onOutput: () => {}, onExit: () => {} },
    );
    const h2 = tm.create(
      { sessionId: "s1", processGeneration: 2, command: "sleep", args: ["10"], env: process.env },
      { onOutput: () => {}, onExit: () => {} },
    );
    assert.strictEqual(tm.get(h1.terminalId, "s1", 1)?.terminalId, h1.terminalId);
    assert.strictEqual(tm.get(h1.terminalId, "s1", 2), undefined);
    assert.strictEqual(tm.forSession("s1", 1).length, 1);
    assert.strictEqual(tm.forSession("s1", 2).length, 1);
    assert.strictEqual(tm.forSession("s2", 1).length, 0);
  });

  it("releases terminals for an old generation", () => {
    const tm = new TerminalManager();
    const h = tm.create(
      { sessionId: "s1", processGeneration: 1, command: "sleep", args: ["10"], env: process.env },
      { onOutput: () => {}, onExit: () => {} },
    );
    tm.releaseFor("s1", 1);
    assert.strictEqual(tm.get(h.terminalId, "s1", 1), undefined);
  });
});
