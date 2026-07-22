/**
 * One `devin acp` child process per active session.
 *
 * The `AcpProcess` owns a stdio JSON-RPC connection to `devin acp` and routes
 * all callbacks through the `SessionController` owner.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ReadableStream, WritableStream } from "node:stream/web";
import * as acp from "@agentclientprotocol/sdk";
import type { TerminalManager } from "./terminal-manager.js";

let permissionSeq = 0;

export interface AcpProcessCallbacks {
  onSessionUpdate: (update: acp.SessionNotification) => void;
  onAgentLog: (channel: string, message: string, level: string) => void;
  onPermissionRequest: (
    requestId: string,
    toolCall: unknown,
    options: Array<{ optionId: string; name: string; kind: string }>,
  ) => void;
  onPermissionResolved: (requestId: string) => void;
  onTerminalOutput: (terminalId: string, data: string) => void;
  onTerminalExit: (terminalId: string, exitCode: number | null, signal: string | null) => void;
  onExit: (code: number | null) => void;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

type PendingPermission = {
  resolve: (r: acp.RequestPermissionResponse) => void;
  timer: NodeJS.Timeout;
};

export class AcpProcess {
  readonly processId: string;
  sessionId: string;
  readonly cwd: string;
  readonly generation: number;
  capabilities: acp.InitializeResponse | null = null;
  exited = false;

  setSessionId(id: string) {
    this.sessionId = id;
  }

  private proc: ChildProcess;
  private conn: acp.ClientSideConnection;
  private pendingPermissions = new Map<string, PendingPermission>();

  private constructor(
    processId: string,
    sessionId: string,
    cwd: string,
    generation: number,
    proc: ChildProcess,
    conn: acp.ClientSideConnection,
  ) {
    this.processId = processId;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.generation = generation;
    this.proc = proc;
    this.conn = conn;
  }

  static async start(
    sessionId: string,
    cwd: string,
    generation: number,
    terminalManager: TerminalManager,
    cbs: AcpProcessCallbacks,
  ): Promise<AcpProcess> {
    const processId = `${sessionId}-g${generation}-${Date.now().toString(36)}`;
    const proc = spawn("devin", ["acp"], {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    let self!: AcpProcess;

    const client: acp.Client = {
      sessionUpdate: (params) => {
        if (params.sessionId !== self.sessionId) return;
        cbs.onSessionUpdate(params);
      },

      requestPermission: (params) => {
        if (params.sessionId !== self.sessionId) {
          return Promise.resolve({ outcome: { outcome: "cancelled" } });
        }
        const requestId = `perm-${Date.now()}-${permissionSeq++}`;
        const options = (params.options ?? []).map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: String(o.kind),
        }));
        cbs.onPermissionRequest(requestId, params.toolCall, options);
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const timer = setTimeout(() => {
            self.pendingPermissions.delete(requestId);
            resolve({ outcome: { outcome: "cancelled" } });
            cbs.onPermissionResolved(requestId);
          }, 5 * 60 * 1000);
          self.pendingPermissions.set(requestId, { resolve, timer });
        });
      },

      readTextFile: async (params) => {
        const p = confine(cwd, params.path);
        const content = await import("node:fs/promises").then((fs) => fs.readFile(p, "utf8"));
        return { content };
      },

      writeTextFile: async (params) => {
        const p = confine(cwd, params.path);
        const fs = await import("node:fs/promises");
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, params.content, "utf8");
      },

      createTerminal: async (params) => {
        return terminalManager.createFromAcp(self.sessionId, generation, params, cwd, {
          onOutput: (h, data) => cbs.onTerminalOutput(h.terminalId, data),
          onExit: (h) => cbs.onTerminalExit(h.terminalId, h.exitCode, h.signal),
        });
      },
      terminalOutput: async (params) => terminalManager.output(params.terminalId),
      waitForTerminalExit: async (params) => terminalManager.waitForExit(params.terminalId),
      killTerminal: async (params) => terminalManager.kill(params.terminalId),
      releaseTerminal: async (params) => terminalManager.release(params.terminalId),
    };

    const clientWithExt = client as acp.Client & { extNotification?: (method: string, params: Record<string, unknown>) => void };
    clientWithExt.extNotification = (method, params) => {
      if (method === "_cognition.ai/output") {
        cbs.onAgentLog(
          String(params.channel ?? ""),
          String(params.message ?? ""),
          String(params.level ?? "info"),
        );
      }
    };

    const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const conn = new acp.ClientSideConnection(() => clientWithExt, stream);

    self = new AcpProcess(processId, sessionId, cwd, generation, proc, conn);

    let handshaken = false;
    let failStart: (err: Error) => void = () => {};
    const startFailed = new Promise<never>((_, reject) => {
      failStart = reject;
    });

    const finish = (code: number | null, err?: Error) => {
      if (self.exited) return;
      self.exited = true;
      for (const [requestId, p] of self.pendingPermissions) {
        clearTimeout(p.timer);
        p.resolve({ outcome: { outcome: "cancelled" } });
        cbs.onPermissionResolved(requestId);
      }
      self.pendingPermissions.clear();
      if (!handshaken) {
        failStart(err ?? new Error(`devin acp exited (code ${code}) before handshake`));
      }
      cbs.onExit(code);
    };

    proc.on("error", (procErr) => {
      finish(null, new Error(`failed to start devin acp: ${procErr.message}`));
      self.kill();
    });
    proc.on("exit", (code) => finish(code));
    proc.stdin!.on("error", () => {});
    proc.stdout!.on("error", () => {});

    try {
      self.capabilities = await Promise.race([
        conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: "devin-remote", version: "0.4.0" },
        }),
        startFailed,
      ]);
    } catch (err) {
      self.kill();
      throw err;
    }
    handshaken = true;
    return self;
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendingPermissions.delete(requestId);
    p.resolve(
      optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } },
    );
    return true;
  }

  async newSession(cwd: string) {
    return this.conn.newSession({ cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string) {
    return this.conn.loadSession({ sessionId, cwd, mcpServers: [] });
  }

  async resumeSession(sessionId: string, cwd: string) {
    return this.conn.resumeSession({ sessionId, cwd, mcpServers: [] });
  }

  async listSessions(cursor?: string) {
    return this.conn.listSessions(cursor ? { cursor } : {});
  }

  async prompt(blocks: acp.ContentBlock[]) {
    return this.conn.prompt({ sessionId: this.sessionId, prompt: blocks });
  }

  async cancel() {
    return this.conn.cancel({ sessionId: this.sessionId });
  }

  async setConfigOption(configId: string, value: string) {
    return this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId, value });
  }

  async renameSession(title: string) {
    for (const m of ["_cognition.ai/session/rename", "_cognition.ai/sessionRename", "session/rename"]) {
      try {
        await this.conn.extMethod(m, { sessionId: this.sessionId, title });
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }

  kill() {
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
}

function confine(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw acp.RequestError.invalidParams(`path escapes workspace: ${p}`);
  }
  return abs;
}
