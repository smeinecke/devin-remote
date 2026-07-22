import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalRunner, resolveTerminalCommand } from "./terminal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collectRunner() {
  const outputs: Array<{ id: string; sessionId: string; data: string }> = [];
  const exits: Array<{ id: string; sessionId: string; code: number | null; signal: string | null }> = [];
  const runner = new TerminalRunner();
  const ev = {
    onTerminalOutput: (id: string, sessionId: string, data: string) => outputs.push({ id, sessionId, data }),
    onTerminalExit: (id: string, sessionId: string, code: number | null, signal: string | null) =>
      exits.push({ id, sessionId, code, signal }),
  };
  return { runner, ev, outputs, exits };
}

describe("resolveTerminalCommand", () => {
  test("direct executable with separate arguments", () => {
    const r = resolveTerminalCommand("git", ["status"]);
    assert.equal(r.file, "git");
    assert.deepEqual(r.args, ["status"]);
    assert.equal(r.shellMode, false);
  });

  test("direct executable without arguments", () => {
    const r = resolveTerminalCommand("git");
    assert.equal(r.file, "git");
    assert.deepEqual(r.args, []);
    assert.equal(r.shellMode, false);
  });

  test("combined command: git status", () => {
    const r = resolveTerminalCommand("git status");
    assert.ok(r.shellMode);
    assert.equal(r.file, "/bin/bash");
    assert.deepEqual(r.args, ["-lc", "git status"]);
  });

  test("combined command: /bin/echo ACP_EXEC_OK", () => {
    const r = resolveTerminalCommand("/bin/echo ACP_EXEC_OK");
    assert.ok(r.shellMode);
    assert.deepEqual(r.args, ["-lc", "/bin/echo ACP_EXEC_OK"]);
  });

  test("combined command with quotes", () => {
    const r = resolveTerminalCommand("printf '%s\\n' \"hello world\"");
    assert.ok(r.shellMode);
    assert.equal(r.args[1], "printf '%s\\n' \"hello world\"");
  });

  test("combined command with redirection/pipes", () => {
    const r = resolveTerminalCommand("cd frontend && npm test");
    assert.ok(r.shellMode);
    assert.equal(r.args[1], "cd frontend && npm test");
  });

  test("combined command with environment assignment", () => {
    const r = resolveTerminalCommand('FOO="a b" printf \'%s\\n\' "$FOO"');
    assert.ok(r.shellMode);
  });
});

describe("TerminalRunner", { timeout: 15000 }, () => {
  test("direct executable plus arguments", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "/bin/echo", args: ["ACP_EXEC_OK"] }, ev);
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /ACP_EXEC_OK/);
  });

  test("combined shell command string", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "/bin/echo ACP_EXEC_OK" }, ev);
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /ACP_EXEC_OK/);
  });

  test("quoted arguments through shell", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "printf '%s\\n' \"hello world\"" }, ev);
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /hello world/);
  });

  test("piped / compound commands", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "echo hello | tr a-z A-Z" }, ev);
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /HELLO/);
  });

  test("environment variables through shell", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create(
      "/",
      {
        sessionId: "s1",
        command: 'printf "%s\\n" "$FOO"',
        env: [{ name: "FOO", value: "a b" }],
      },
      ev,
    );
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /a b/);
  });

  test("working-directory handling", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-term-"));
    fs.writeFileSync(path.join(tmp, "marker"), "cwd-ok");
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "cat marker", cwd: tmp }, ev);
    await runner.waitForExit(terminalId);
    fs.rmSync(tmp, { recursive: true, force: true });
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /cwd-ok/);
  });

  test("stdout and stderr merged through pty", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "echo out; echo err >&2" }, ev);
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /out/);
    assert.match(output, /err/);
  });

  test("exit code propagation", async () => {
    const { runner, ev } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "bash", args: ["-lc", "exit 42"] }, ev);
    const status = await runner.waitForExit(terminalId);
    assert.equal(status.exitCode, 42);
    assert.equal(status.signal, null);
  });

  test("Ctrl+C (kill terminal)", async () => {
    const { runner, ev } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "sleep 10" }, ev);
    await sleep(100);
    runner.kill(terminalId);
    const status = await runner.waitForExit(terminalId);
    assert.equal(status.signal, "SIGKILL");
  });

  test("interactive stdin", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create(
      "/",
      { sessionId: "s1", command: 'read -p "Name: " name; printf "Hello %s\\n" "$name"' },
      ev,
    );
    await sleep(100);
    runner.write(terminalId, "Calvin\n", "s1");
    await runner.waitForExit(terminalId);
    const output = outputs.map((o) => o.data).join("");
    assert.match(output, /Hello Calvin/);
  });

  test("terminal resize", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-term-"));
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create(
      tmp,
      { sessionId: "s1", command: "read a; stty size" },
      ev,
    );
    await sleep(100);
    const ok = runner.resize(terminalId, 100, 40, "s1");
    assert.equal(ok, true);
    runner.write(terminalId, "\n", "s1");
    await runner.waitForExit(terminalId);
    fs.rmSync(tmp, { recursive: true, force: true });
    const output = outputs.map((o) => o.data).join("");
    // stty size prints: rows cols
    assert.match(output, /40\s+100/);
  });

  test("unknown terminal id", async () => {
    const { runner } = collectRunner();
    assert.equal(runner.write("not-real", "x"), false);
    assert.equal(runner.resize("not-real", 80, 24), false);
    assert.equal(runner.kill("not-real"), undefined);
    assert.throws(() => runner.output("not-real"), /unknown terminal/);
  });

  test("input after process exit", async () => {
    const { runner, ev } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "echo done" }, ev);
    await runner.waitForExit(terminalId);
    assert.equal(runner.write(terminalId, "late\n", "s1"), false);
  });

  test("cleanup after release", async () => {
    const { runner, ev } = collectRunner();
    const { terminalId } = await runner.create("/", { sessionId: "s1", command: "sleep 10" }, ev);
    await sleep(50);
    runner.release(terminalId);
    assert.equal(runner.write(terminalId, "x", "s1"), false);
    assert.equal(runner.resize(terminalId, 80, 24, "s1"), false);
    assert.throws(() => runner.output(terminalId), /unknown terminal/);
  });

  test("multiple simultaneous terminals", async () => {
    const { runner, ev } = collectRunner();
    const a = await runner.create("/", { sessionId: "s1", command: "echo A" }, ev);
    const b = await runner.create("/", { sessionId: "s2", command: "echo B" }, ev);
    const [sa, sb] = await Promise.all([runner.waitForExit(a.terminalId), runner.waitForExit(b.terminalId)]);
    assert.equal(sa.exitCode, 0);
    assert.equal(sb.exitCode, 0);
  });

  test("output truncation at UTF-8 boundaries", async () => {
    const { runner, ev, outputs } = collectRunner();
    const { terminalId } = await runner.create(
      "/",
      { sessionId: "s1", command: "printf '%s\\n' αβγδε", outputByteLimit: 8 },
      ev,
    );
    await runner.waitForExit(terminalId);
    const out = runner.output(terminalId);
    assert.equal(out.truncated, true);
    // UTF-8 greek letters are two bytes each; 8 bytes may be <= limit.
    assert.ok(Buffer.byteLength(out.output, "utf8") <= 8);
    // Should be valid UTF-8 (no broken surrogate/sequence).
    assert.doesNotThrow(() => Buffer.from(out.output, "utf8").toString("utf8"));
  });
});
