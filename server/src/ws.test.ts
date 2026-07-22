import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { TerminalRunner } from "./terminal.js";
import { WsHub } from "./ws.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestCtx {
  server: http.Server;
  hub: WsHub;
  runner: TerminalRunner;
  port: number;
  close: () => Promise<void>;
}

async function setup(): Promise<TestCtx> {
  const runner = new TerminalRunner();
  const server = http.createServer();
  const hub = new WsHub(
    server,
    () => ({
      type: "config",
      app: { name: "test", version: "0" },
      settings: { theme: "dark", soundComplete: false, soundNotify: false, desktopNotify: false },
    }),
    runner,
    { verifyOrigin: () => true },
  );
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve();
      else reject(new Error("server did not bind to port"));
    });
  });
  const port = (server.address() as { port: number }).port;

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return { server, hub, runner, port, close };
}

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: unknown[] = [];
  const send = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  return new Promise<{
    ws: WebSocket;
    messages: unknown[];
    send: (obj: unknown) => void;
    close: () => void;
  }>((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages, send, close: () => ws.close() }));
    ws.on("message", (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        messages.push(String(raw));
      }
    });
    ws.on("error", reject);
  });
}

test("valid terminal input is forwarded", { timeout: 5000 }, async () => {
  const ctx = await setup();
  const outputs: string[] = [];
  const ev = {
    onTerminalOutput: (_id: string, _sid: string, data: string) => outputs.push(data),
    onTerminalExit: () => {},
  };
  const { terminalId } = await ctx.runner.create("/", { sessionId: "s1", command: "cat" }, ev);
  const client = await connect(ctx.port);
  try {
    await sleep(50);
    client.send({ type: "terminal_input", terminalId, data: "hello\n", sessionId: "s1" });
    await sleep(100);
    client.send({ type: "terminal_input", terminalId, data: "\u0004", sessionId: "s1" });
    await ctx.runner.waitForExit(terminalId);
    const output = outputs.join("");
    assert.match(output, /hello/);
  } finally {
    client.close();
    await ctx.close();
  }
});

test("malformed JSON and missing fields are ignored", { timeout: 5000 }, async () => {
  const ctx = await setup();
  const client = await connect(ctx.port);
  try {
    await sleep(50);
    client.ws.send("{not json");
    client.send({ type: "terminal_input", data: "x" });
    client.send({ type: "unknown", terminalId: "x", data: "y" });
    await sleep(100);
  } finally {
    client.close();
    await ctx.close();
  }
});

test("oversized terminal input is rejected", { timeout: 5000 }, async () => {
  const ctx = await setup();
  const outputs: string[] = [];
  const ev = {
    onTerminalOutput: (_id: string, _sid: string, data: string) => outputs.push(data),
    onTerminalExit: () => {},
  };
  const { terminalId } = await ctx.runner.create("/", { sessionId: "s1", command: "cat" }, ev);
  const client = await connect(ctx.port);
  try {
    await sleep(50);
    const huge = "x".repeat(70 * 1024);
    client.send({ type: "terminal_input", terminalId, data: huge, sessionId: "s1" });
    await sleep(100);
    client.send({ type: "terminal_input", terminalId, data: "\u0004", sessionId: "s1" });
    await ctx.runner.waitForExit(terminalId);
    const output = outputs.join("");
    assert.doesNotMatch(output, /x{100}/);
  } finally {
    client.close();
    await ctx.close();
  }
});

test("input for unknown or exited terminal is rejected", { timeout: 5000 }, async () => {
  const ctx = await setup();
  const client = await connect(ctx.port);
  try {
    await sleep(50);
    client.send({ type: "terminal_input", terminalId: "not-real", data: "x" });
    const ev = { onTerminalOutput: () => {}, onTerminalExit: () => {} };
    const { terminalId } = await ctx.runner.create("/", { sessionId: "s1", command: "echo done" }, ev);
    await ctx.runner.waitForExit(terminalId);
    client.send({ type: "terminal_input", terminalId, data: "late", sessionId: "s1" });
    await sleep(50);
  } finally {
    client.close();
    await ctx.close();
  }
});

test("terminal resize is validated and forwarded", { timeout: 5000 }, async () => {
  const ctx = await setup();
  const outputs: string[] = [];
  const ev = {
    onTerminalOutput: (_id: string, _sid: string, data: string) => outputs.push(data),
    onTerminalExit: () => {},
  };
  const { terminalId } = await ctx.runner.create("/", { sessionId: "s1", command: "read a; stty size" }, ev);
  const client = await connect(ctx.port);
  try {
    await sleep(50);
    // Out of bounds; should be ignored.
    client.send({ type: "terminal_resize", terminalId, cols: 1, rows: 1, sessionId: "s1" });
    // Valid resize.
    client.send({ type: "terminal_resize", terminalId, cols: 100, rows: 40, sessionId: "s1" });
    // Trigger the command after the resize has been applied.
    client.send({ type: "terminal_input", terminalId, data: "\n", sessionId: "s1" });
    await ctx.runner.waitForExit(terminalId);
    const output = outputs.join("");
    // stty size prints: rows cols
    assert.match(output, /40\s+100/);
  } finally {
    client.close();
    await ctx.close();
  }
});
