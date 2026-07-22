import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import type { DevinAcpEvents } from "./acp.js";

const MAX_OUTPUT = 1024 * 1024; // 1 MiB per terminal
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESIZE_COLS = 500;
const MIN_RESIZE_COLS = 20;
const MAX_RESIZE_ROWS = 300;
const MIN_RESIZE_ROWS = 5;

const DEBUG = process.env.DEVIN_REMOTE_DEBUG === "1";

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[devin-remote terminal]", ...args);
}

const SIGNAL_BY_NUMBER = new Map<number, string>();
for (const [name, num] of Object.entries(osConstants.signals)) {
  if (!SIGNAL_BY_NUMBER.has(num)) SIGNAL_BY_NUMBER.set(num, name);
}

function signalName(signal?: number): string | null {
  if (!signal) return null;
  return SIGNAL_BY_NUMBER.get(signal) ?? `Signal${signal}`;
}

export interface ResolvedTerminalCommand {
  file: string;
  args: string[];
  shellMode: boolean;
}

export function resolveTerminalCommand(
  command: string,
  args?: string[],
): ResolvedTerminalCommand {
  const hasArgs = (args ?? []).length > 0;
  if (hasArgs) {
    return { file: command, args: args as string[], shellMode: false };
  }

  // Combined shell command line: whitespace or any shell metacharacter.
  const shellMetachar = /[\s|&;<>()$`\\'"*?[\]{}~=]/;
  if (shellMetachar.test(command)) {
    const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    return { file: shell, args: ["-lc", command], shellMode: true };
  }

  return { file: command, args: [], shellMode: false };
}

interface Terminal {
  id: string;
  sessionId: string;
  pty: IPty | null;
  output: Buffer;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  waiters: Array<() => void>;
  limit: number;
  cols: number;
  rows: number;
  settled: boolean;
  released: boolean;
  dispose: () => void;
  settle: (code: number | null, sig: string | null) => void;
}

export class TerminalRunner {
  private terminals = new Map<string, Terminal>();

  async create(
    defaultCwd: string,
    params: CreateTerminalRequest,
    ev: Pick<DevinAcpEvents, "onTerminalOutput" | "onTerminalExit">,
  ): Promise<CreateTerminalResponse> {
    const id = randomUUID();
    const sessionId = params.sessionId;
    let cwd = params.cwd ?? defaultCwd;
    if (!path.isAbsolute(cwd)) cwd = defaultCwd;

    const requestedCommand = params.command;
    const requestedArgs = params.args ?? [];
    const resolved = resolveTerminalCommand(requestedCommand, requestedArgs);

    const limit = params.outputByteLimit ?? MAX_OUTPUT;

    const childEnv: { [key: string]: string | undefined } = {
      ...process.env,
      ...Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
    };
    childEnv.TERM = "xterm-256color";
    childEnv.COLORTERM = "truecolor";

    const meta = (params as { _meta?: Record<string, unknown> | null })._meta;
    const cols = clampDimension(
      numberFromUnknown(meta?.cols, DEFAULT_COLS),
      MIN_RESIZE_COLS,
      MAX_RESIZE_COLS,
    );
    const rows = clampDimension(
      numberFromUnknown(meta?.rows, DEFAULT_ROWS),
      MIN_RESIZE_ROWS,
      MAX_RESIZE_ROWS,
    );

    debug("create", {
      terminalId: id,
      sessionId,
      requestedCommand,
      requestedArgs,
      resolved: { file: resolved.file, args: resolved.args, shellMode: resolved.shellMode },
      cwd,
      cwdExists: existsSync(cwd),
      cols,
      rows,
      envKeys: Object.keys(childEnv).length,
      providedEnvKeys: (params.env ?? []).map((e) => e.name),
      limit,
    });

    const term: Terminal = {
      id,
      sessionId,
      pty: null,
      output: Buffer.alloc(0),
      truncated: false,
      exitCode: null,
      signal: null,
      waiters: [],
      limit,
      cols,
      rows,
      settled: false,
      released: false,
      dispose: () => {},
      settle: () => {},
    };

    const appendOutput = (data: string) => {
      if (term.released) return;
      const chunk = Buffer.from(data, "utf8");
      let buf = Buffer.concat([term.output, chunk]);
      if (buf.length > term.limit) {
        let cut = 0;
        // Trim from the beginning, always on a UTF-8 character boundary.
        while (buf.length - cut > term.limit) {
          cut++;
          while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut++;
        }
        if (cut > 0) {
          buf = buf.slice(cut);
          term.truncated = true;
        }
      }
      term.output = buf;
      ev.onTerminalOutput(id, sessionId, data);
    };

    const settle = (code: number | null, sig: string | null) => {
      if (term.settled) return;
      term.settled = true;
      term.exitCode = code;
      term.signal = sig;
      if (!term.released) {
        ev.onTerminalExit(id, sessionId, code, sig);
      }
      for (const w of term.waiters) w();
      term.waiters = [];
    };

    term.settle = settle;

    try {
      const pty = ptySpawn(resolved.file, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: childEnv,
        encoding: "utf8",
      });

      term.pty = pty;
      this.terminals.set(id, term);

      const dataDispose = pty.onData(appendOutput);
      const exitDispose = pty.onExit((event) => {
        const sig = signalName(event.signal);
        const code = sig ? null : event.exitCode;
        debug("exit", { terminalId: id, exitCode: code, signal: sig, raw: event });
        settle(code, sig);
      });

      term.dispose = () => {
        dataDispose.dispose();
        exitDispose.dispose();
      };

      debug("spawned", { terminalId: id, pid: pty.pid, file: resolved.file, args: resolved.args });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      const errorLine = `[devin-remote] failed to start terminal: ${message}\n`;
      appendOutput(errorLine);
      debug("spawn error", { terminalId: id, message });
      settle(-1, null);
      this.terminals.set(id, term);
    }

    return { terminalId: id };
  }

  output(terminalId: string): TerminalOutputResponse {
    const t = this.mustGet(terminalId);
    const exited = t.settled;
    const response: TerminalOutputResponse = {
      output: t.output.toString("utf8"),
      truncated: t.truncated,
    };
    if (exited) {
      response.exitStatus = { exitCode: t.exitCode, signal: t.signal };
    }
    return response;
  }

  waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const t = this.mustGet(terminalId);
    if (t.settled) {
      return Promise.resolve({ exitCode: t.exitCode, signal: t.signal });
    }
    return new Promise<void>((resolve) => t.waiters.push(resolve)).then(() => ({
      exitCode: t.exitCode,
      signal: t.signal,
    }));
  }

  write(terminalId: string, data: string, sessionId?: string): boolean {
    const t = this.terminals.get(terminalId);
    if (!t || !t.pty || t.settled) return false;
    if (sessionId && t.sessionId !== sessionId) return false;
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      debug("input rejected: too large", { terminalId, size: Buffer.byteLength(data, "utf8") });
      return false;
    }
    try {
      t.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(terminalId: string, cols: number, rows: number, sessionId?: string): boolean {
    const t = this.terminals.get(terminalId);
    if (!t || !t.pty || t.settled) return false;
    if (sessionId && t.sessionId !== sessionId) return false;
    if (
      !Number.isFinite(cols) ||
      !Number.isFinite(rows) ||
      cols < MIN_RESIZE_COLS ||
      cols > MAX_RESIZE_COLS ||
      rows < MIN_RESIZE_ROWS ||
      rows > MAX_RESIZE_ROWS
    ) {
      debug("resize rejected: out of bounds", { terminalId, cols, rows });
      return false;
    }
    try {
      t.pty.resize(cols, rows);
      t.cols = cols;
      t.rows = rows;
      debug("resize", { terminalId, cols, rows });
      return true;
    } catch {
      return false;
    }
  }

  kill(terminalId: string) {
    const t = this.terminals.get(terminalId);
    if (!t || t.settled || !t.pty) return;
    this.killProcess(t);
  }

  release(terminalId: string) {
    const t = this.terminals.get(terminalId);
    if (!t || t.released) return;
    t.released = true;
    if (!t.settled) {
      this.killProcess(t);
      t.settle(null, null);
    }
    if (t.pty) {
      t.dispose();
      try {
        t.pty.kill("SIGKILL");
      } catch {
        /* may already be gone */
      }
    }
    this.terminals.delete(terminalId);
  }

  killAll() {
    for (const t of this.terminals.values()) {
      if (!t.settled) this.killProcess(t);
    }
    this.terminals.clear();
  }

  private killProcess(t: Terminal) {
    if (!t.pty || t.settled) return;
    try {
      const pid = t.pty.pid;
      if (pid > 1) {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      try {
        t.pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  private mustGet(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`unknown terminal: ${id}`);
    return t;
  }
}

function clampDimension(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function numberFromUnknown(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
