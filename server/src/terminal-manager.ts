/**
 * Terminal registry keyed by (sessionId, processGeneration, terminalId).
 *
 * This prevents terminal output leaking across sessions or process restarts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

export interface TerminalHandle {
  terminalId: string;
  sessionId: string;
  processGeneration: number;
  command: string;
  status: "running" | "exited" | "killed" | "failed";
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
}

interface CreateParams {
  sessionId: string;
  processGeneration: number;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  outputByteLimit?: number | null;
  usePty?: boolean;
}

export interface TerminalCallbacks {
  onOutput: (handle: TerminalHandle, data: string) => void;
  onExit: (handle: TerminalHandle) => void;
}

const MAX_OUTPUT = 1024 * 1024;

export class TerminalManager {
  private terminals = new Map<string, TerminalHandle>();
  private procs = new Map<string, ChildProcess>();

  create(params: CreateParams, cbs: TerminalCallbacks): TerminalHandle {
    const terminalId = randomUUID();
    const limit = params.outputByteLimit ?? MAX_OUTPUT;

    // Combined shell command compatibility: "git status" with args []
    // is executed through a shell, while "git" with args ["status"] is direct.
    const useShell = params.args.length === 0;
    const proc = useShell
      ? spawn(params.command, [], { cwd: params.cwd, env: params.env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(params.command, params.args, {
          cwd: params.cwd,
          env: params.env,
          stdio: params.usePty ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        });

    const handle: TerminalHandle = {
      terminalId,
      sessionId: params.sessionId,
      processGeneration: params.processGeneration,
      command: params.command,
      status: "running",
      exitCode: null,
      signal: null,
      output: "",
      truncated: false,
    };

    this.terminals.set(terminalId, handle);
    this.procs.set(terminalId, proc);

    const append = (data: string) => {
      handle.output += data;
      if (handle.output.length > limit) {
        handle.output = handle.output.slice(-limit);
        handle.truncated = true;
      }
      cbs.onOutput(handle, data);
    };

    proc.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));

    const settle = (code: number | null, signal: string | null) => {
      if (handle.status !== "running") return;
      if (signal) {
        handle.status = "killed";
        handle.signal = signal;
      } else {
        handle.status = code === 0 ? "exited" : "failed";
      }
      handle.exitCode = code;
      cbs.onExit(handle);
    };

    proc.on("exit", (code, signal) => settle(code, signal));
    proc.on("error", (err) => {
      const msg = `[devin-remote] failed to start "${params.command}": ${err.message}\n`;
      append(msg);
      settle(-1, null);
    });

    return handle;
  }

  /** Create a terminal from an ACP CreateTerminalRequest. */
  createFromAcp(
    sessionId: string,
    processGeneration: number,
    req: acp.CreateTerminalRequest,
    defaultCwd: string,
    cbs: TerminalCallbacks,
  ): { terminalId: string } {
    const command = req.command;
    const args = req.args ?? [];
    const cwd = req.cwd ?? defaultCwd;
    const envEntries = (req.env ?? [])
      .filter((e): e is { name: string; value: string } => typeof e.name === "string" && typeof e.value === "string")
      .map((e) => [e.name, e.value] as const);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...Object.fromEntries(envEntries),
    };
    const handle = this.create(
      {
        sessionId,
        processGeneration,
        command,
        args,
        cwd,
        env,
        outputByteLimit: req.outputByteLimit ?? undefined,
      },
      cbs,
    );
    return { terminalId: handle.terminalId };
  }

  get(terminalId: string, sessionId?: string, processGeneration?: number): TerminalHandle | undefined {
    const t = this.terminals.get(terminalId);
    if (!t) return undefined;
    if (sessionId && t.sessionId !== sessionId) return undefined;
    if (processGeneration !== undefined && t.processGeneration !== processGeneration) return undefined;
    return t;
  }

  forSession(sessionId: string, processGeneration?: number): TerminalHandle[] {
    return [...this.terminals.values()].filter(
      (t) => t.sessionId === sessionId && (processGeneration === undefined || t.processGeneration === processGeneration),
    );
  }

  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
    const t = this.mustGet(terminalId);
    const exited = t.status !== "running";
    return {
      output: t.output,
      truncated: t.truncated,
      ...(exited ? { exitStatus: { exitCode: t.exitCode, signal: t.signal } } : {}),
    };
  }

  async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const t = this.mustGet(terminalId);
    if (t.status !== "running") {
      return { exitCode: t.exitCode, signal: t.signal };
    }
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const cur = this.terminals.get(terminalId);
        if (cur && cur.status !== "running") {
          clearInterval(check);
          resolve({ exitCode: cur.exitCode, signal: cur.signal });
        }
      }, 50);
    });
  }

  kill(terminalId: string) {
    const t = this.terminals.get(terminalId);
    const proc = this.procs.get(terminalId);
    if (t && proc && t.status === "running") {
      try {
        t.status = "killed";
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }

  release(terminalId: string) {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
    this.procs.delete(terminalId);
  }

  /** Remove all terminals for a process generation. */
  releaseFor(sessionId: string, processGeneration: number) {
    for (const [id, t] of this.terminals) {
      if (t.sessionId === sessionId && t.processGeneration === processGeneration) {
        this.procs.get(id)?.kill("SIGKILL");
        this.terminals.delete(id);
        this.procs.delete(id);
      }
    }
  }

  /** Resize a PTY if the terminal was created with usePty. */
  resize(_terminalId: string, _cols: number, _rows: number) {
    // PTY resize is a no-op in this implementation; native pty is not required.
  }

  listForSession(sessionId: string): TerminalHandle[] {
    return [...this.terminals.values()].filter((t) => t.sessionId === sessionId);
  }

  killAll() {
    for (const [id, proc] of this.procs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* */
      }
      this.terminals.delete(id);
    }
    this.procs.clear();
  }

  private mustGet(id: string): TerminalHandle {
    const t = this.terminals.get(id);
    if (!t) throw new Error(`unknown terminal: ${id}`);
    return t;
  }
}
