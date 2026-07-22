import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionController } from "../src/session-controller.js";
import { EventBus } from "../src/event-bus.js";

class FakeAcpProcess {
  exited = false;
  killed = false;
  terminated = false;
  sessionId: string;
  cbs: any;
  capabilities: any = null;
  promptResolve: ((v: any) => void) | null = null;
  promptReject: ((e: any) => void) | null = null;

  constructor(sessionId: string, cbs: any) {
    this.sessionId = sessionId;
    this.cbs = cbs;
  }

  setSessionId(id: string) {
    this.sessionId = id;
  }

  async newSession(_cwd: string) {
    return { sessionId: this.sessionId, modes: null };
  }

  async loadSession(_sessionId: string, _cwd: string) {
    return { sessionId: this.sessionId, modes: null };
  }

  async resumeSession(_sessionId: string, _cwd: string) {
    return { sessionId: this.sessionId, modes: null };
  }

  async prompt(_blocks: any) {
    return new Promise((resolve, reject) => {
      this.promptResolve = resolve;
      this.promptReject = reject;
    });
  }

  async cancel() {}

  kill() {
    this.killed = true;
  }

  async terminate() {
    this.terminated = true;
    this.exited = true;
  }

  emitUpdate(update: any) {
    this.cbs.onSessionUpdate(update);
  }

  emitExit(code: number | null = null) {
    this.exited = true;
    this.cbs.onExit(code);
  }

  resolvePrompt(result: any) {
    this.promptResolve?.(result);
  }

  rejectPrompt(err: any) {
    this.promptReject?.(err);
  }
}

function makeFactory(processes: FakeAcpProcess[]) {
  return async (_cwd: string, generation: number, cbs: any) => {
    const p = new FakeAcpProcess(`s-${generation}`, cbs);
    processes.push(p);
    return p as any;
  };
}

const fakeTerminalManager = {
  releaseFor: () => {},
} as any;

describe("SessionController", () => {
  it("increments generation on create and guards callbacks", async () => {
    const bus = new EventBus();
    const c = new SessionController("s1", "/tmp", fakeTerminalManager, bus, {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });
    const processes: FakeAcpProcess[] = [];

    await c.create(makeFactory(processes));
    assert.strictEqual(c.processGeneration, 1);
    assert.strictEqual(processes.length, 1);

    // Force a restart by moving to failed, then attach again.
    c.status = "failed";
    await c.attach(makeFactory(processes));
    assert.strictEqual(c.processGeneration, 2);
    assert.strictEqual(processes.length, 2);

    const emitted: any[] = [];
    bus.subscribe((_sid, env) => emitted.push(env));

    // Emit from the old (gen 1) process. It should be ignored.
    processes[0].emitUpdate({ sessionId: "s1", sessionUpdate: "agent_message_chunk", content: { text: "x" } });
    assert.strictEqual(emitted.length, 0);

    // Emit from the new (gen 2) process. It should be accepted.
    processes[1].emitUpdate({ sessionId: "s2", sessionUpdate: "agent_message_chunk", content: { text: "y" } });
    assert.strictEqual(emitted.length, 1);
  });

  it("cancels and transitions to idle when prompt rejects", async () => {
    const bus = new EventBus();
    const c = new SessionController("s1", "/tmp", fakeTerminalManager, bus, {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });
    const processes: FakeAcpProcess[] = [];
    await c.create(makeFactory(processes));
    c.status = "idle";

    const promptP = c.prompt([{ type: "text", text: "hi" }]);
    assert.strictEqual(c.status, "running");

    // Trigger cancel while running.
    const cancelP = c.cancel();
    processes[0].rejectPrompt(new Error("cancelled"));
    await Promise.all([promptP.catch(() => {}), cancelP]);

    assert.strictEqual(c.status, "idle");
  });

  it("kills ACP and transitions to failed when cancel times out", async () => {
    const bus = new EventBus();
    const c = new SessionController("s1", "/tmp", fakeTerminalManager, bus, {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });
    const processes: FakeAcpProcess[] = [];
    await c.create(makeFactory(processes));
    c.status = "idle";

    const promptP = c.prompt([{ type: "text", text: "hi" }]);
    // Do not resolve the prompt; let cancel timeout.
    await c.cancel();

    assert.strictEqual(c.status, "failed");
    assert.strictEqual(processes[0].killed, true);
    // Clean up hanging prompt.
    processes[0].rejectPrompt(new Error("cancelled"));
    await promptP.catch(() => {});
  });

  it("does not let a stale prompt completion corrupt the replacement generation", async () => {
    const bus = new EventBus();
    const promptDoneGenerations: number[] = [];
    bus.subscribe((_sid, env) => {
      if (env.type === "event" && (env as any).eventType === "prompt_done") {
        promptDoneGenerations.push((env as any).processGeneration);
      }
    });

    const c = new SessionController("s1", "/tmp", fakeTerminalManager, bus, {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });
    const processes: FakeAcpProcess[] = [];
    await c.create(makeFactory(processes));
    c.status = "idle";

    // Start prompt A in generation 1.
    const promptA = c.prompt([{ type: "text", text: "a" }]);
    assert.strictEqual(c.status, "running");

    // Simulate a replacement: move to failed and attach generation 2.
    c.status = "failed";
    await c.attach(makeFactory(processes));
    assert.strictEqual(c.processGeneration, 2);

    // Start prompt B in generation 2.
    const promptB = c.prompt([{ type: "text", text: "b" }]);
    assert.strictEqual(c.status, "running");

    // Resolve the stale generation-1 prompt.
    processes[0].resolvePrompt({ result: "A" });
    await assert.rejects(() => promptA, /stale prompt completion/);

    // Generation 2 should still be running and tracking prompt B.
    assert.strictEqual(c.status, "running");

    // Resolve generation-2 prompt.
    processes[1].resolvePrompt({ result: "B" });
    const resultB = await promptB;
    assert.strictEqual(resultB.result, "B");
    assert.strictEqual(c.status, "idle");

    // Only one prompt_done event should have been emitted, for generation 2.
    assert.deepStrictEqual(promptDoneGenerations, [2]);
  });

  it("preserves activeOperation for the replacement prompt when a stale prompt settles", async () => {
    const c = new SessionController("s1", "/tmp", fakeTerminalManager, new EventBus(), {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });
    const processes: FakeAcpProcess[] = [];
    await c.create(makeFactory(processes));
    c.status = "idle";

    // Start prompt A in generation 1.
    const promptA = c.prompt([{ type: "text", text: "a" }]);
    const opA = c.snapshot().activeOperation;
    assert.match(opA ?? "", /^prompt-/);

    // Replace with generation 2 and start prompt B.
    c.status = "failed";
    await c.attach(makeFactory(processes));
    const promptB = c.prompt([{ type: "text", text: "b" }]);
    const opB = c.snapshot().activeOperation;
    assert.match(opB ?? "", /^prompt-/);

    // Settle the stale generation-1 prompt.
    processes[0].resolvePrompt({ result: "A" });
    await promptA.catch(() => {});

    // activeOperation should still refer to prompt B.
    assert.strictEqual(c.snapshot().activeOperation, opB);

    // Clean up B.
    processes[1].resolvePrompt({ result: "B" });
    await promptB;
  });

  it("transitions to failed when the ACP factory rejects and allows a second attach", async () => {
    const bus = new EventBus();
    const c = new SessionController("s1", "/tmp", fakeTerminalManager, bus, {
      onPermissionOwner: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    });

    let attempts = 0;
    const failingFactory = async (_cwd: string, generation: number, cbs: any) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("factory failed");
      }
      const p = new FakeAcpProcess(`s-${generation}`, cbs);
      return p as any;
    };

    c.status = "failed";
    await assert.rejects(() => c.attach(failingFactory), /factory failed/);
    assert.strictEqual(c.status, "failed");

    await c.attach(failingFactory);
    assert.strictEqual(c.status, "idle");
  });
});
