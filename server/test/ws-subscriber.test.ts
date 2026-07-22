import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { SessionRegistry } from "../src/session-registry.js";
import { WsSubscriber } from "../src/ws-subscriber.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WsSubscriber", () => {
  it("notifies the client and switches subscription when the requested generation is stale", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const registry = new SessionRegistry();
    const controller = registry.getOrCreate("s1", "/tmp");
    controller.processGeneration = 2;
    controller.status = "idle";

    const subscriber = new WsSubscriber(
      server,
      registry,
      registry.eventBus,
      () => ({ type: "config", app: { name: "devin-remote", version: "0" }, settings: {} } as any),
    );

    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));

    await once(ws, "open");
    // Wait for hello.
    await wait(50);

    ws.send(JSON.stringify({ type: "subscribe", sessions: { s1: { processGeneration: 1, after: 0 } } }));
    await wait(150);

    const gen = messages.find((m) => m.type === "generation_changed");
    assert.ok(gen, "expected a generation_changed message");
    assert.strictEqual(gen.sessionId, "s1");
    assert.strictEqual(gen.previousGeneration, 1);
    assert.strictEqual(gen.processGeneration, 2);

    const snap = messages.find((m) => m.type === "snapshot" && m.processGeneration === 2);
    assert.ok(snap, "expected a snapshot for the current generation");
    assert.strictEqual(snap.sessionId, "s1");
    assert.strictEqual(snap.processGeneration, 2);

    // Clean up all handles so the test runner can exit.
    ws.terminate();
    (subscriber as any).wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await wait(50);
  });
});
