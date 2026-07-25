import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { StoreShape, UsageRecord, SessionMetadata } from "./types.js";

const DEFAULTS: StoreShape = {
  aliases: {},
  workspaces: [],
  usage: [],
  sessions: {},
  droppedSessions: [],
  settings: {
    theme: "dark",
    soundComplete: true,
    soundNotify: true,
    desktopNotify: false,
    worktreeIsolation: true,
  },
};

const MAX_USAGE_RECORDS = 50_000;

export class Store {
  readonly dataDir: string;
  readonly uploadsDir: string;
  private file: string;
  private data: StoreShape;
  private saveTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private tmpSeq = 0;

  constructor() {
    this.dataDir =
      process.env.DEVIN_REMOTE_HOME ??
      process.env.DEVIN_CONSOLE_HOME ??
      path.join(os.homedir(), ".devin-remote");
    const legacy = path.join(os.homedir(), ".devin-console");
    if (!process.env.DEVIN_REMOTE_HOME && !fs.existsSync(this.dataDir) && fs.existsSync(legacy)) {
      fs.cpSync(legacy, this.dataDir, { recursive: true });
    }
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.file = path.join(this.dataDir, "store.json");
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    for (const f of fs.readdirSync(this.dataDir)) {
      if (f.startsWith("store.json.") && f.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.join(this.dataDir, f));
        } catch {
          /* */
        }
      }
    }
    this.data = this.load();
    this.migrate();
  }

  private load(): StoreShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...DEFAULTS,
        ...raw,
        settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
        sessions: { ...DEFAULTS.sessions, ...(raw.sessions ?? {}) },
        droppedSessions: [...(raw.droppedSessions ?? [])],
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  private migrate() {
    // Legacy aliases/workspaces did not have a sessions record. v0.4 stores
    // per-session metadata (worktree, branch, status) here.
    let changed = false;
    for (const [id, alias] of Object.entries(this.data.aliases)) {
      if (!this.data.sessions[id]) {
        this.data.sessions[id] = {
          sessionId: id,
          cwd: this.data.workspaces[0] ?? "",
          alias: alias || null,
          title: null,
          branch: null,
          worktree: null,
          updatedAt: null,
          status: null,
        };
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, 250);
  }

  private persist() {
    const json = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.${process.pid}.${++this.tmpSeq}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.writeFile(tmp, json);
        await fsp.rename(tmp, this.file);
      })
      .catch((err) => {
        console.error(`store: failed to write ${this.file}:`, err);
        void fsp.unlink(tmp).catch(() => {});
      });
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.${process.pid}.${++this.tmpSeq}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`store: failed to flush ${this.file}:`, err);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* */
      }
    }
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch: Partial<StoreShape["settings"]>) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  alias(sessionId: string): string | undefined {
    return this.data.aliases[sessionId];
  }

  setAlias(sessionId: string, title: string) {
    if (title) this.data.aliases[sessionId] = title;
    else delete this.data.aliases[sessionId];
    this.ensureSession(sessionId);
    this.data.sessions[sessionId]!.alias = title || null;
    this.save();
  }

  aliases(): Record<string, string> {
    return this.data.aliases;
  }

  workspaces(): string[] {
    return this.data.workspaces;
  }

  addWorkspace(cwd: string) {
    const normalised = cwd.replace(/[/\\]+$/, "");
    const list = this.data.workspaces.filter((w) => w !== normalised);
    list.unshift(normalised);
    if (list.length > 20) list.length = 20;
    this.data.workspaces = list;
    this.save();
  }

  setWorkspaces(workspaces: string[]) {
    this.data.workspaces = workspaces.slice(0, 20);
    this.save();
  }

  sessions(): Record<string, SessionMetadata> {
    return this.data.sessions;
  }

  session(sessionId: string): SessionMetadata | undefined {
    return this.data.sessions[sessionId];
  }

  ensureSession(sessionId: string, defaults?: Partial<SessionMetadata>) {
    if (!this.data.sessions[sessionId]) {
      this.data.sessions[sessionId] = {
        sessionId,
        cwd: defaults?.cwd ?? "",
        title: defaults?.title ?? null,
        alias: defaults?.alias ?? this.data.aliases[sessionId] ?? null,
        branch: defaults?.branch ?? null,
        worktree: defaults?.worktree ?? null,
        updatedAt: defaults?.updatedAt ?? null,
        status: defaults?.status ?? null,
      };
      this.save();
    } else if (defaults) {
      Object.assign(this.data.sessions[sessionId]!, defaults);
      this.save();
    }
  }

  setSession(sessionId: string, patch: Partial<SessionMetadata>) {
    this.ensureSession(sessionId);
    Object.assign(this.data.sessions[sessionId]!, patch);
    this.save();
  }

  dropSession(sessionId: string) {
    delete this.data.aliases[sessionId];
    delete this.data.sessions[sessionId];
    if (!this.data.droppedSessions.includes(sessionId)) {
      this.data.droppedSessions.push(sessionId);
    }
    this.save();
  }

  isDropped(sessionId: string): boolean {
    return this.data.droppedSessions.includes(sessionId);
  }

  recordUsage(rec: UsageRecord) {
    this.data.usage.push(rec);
    if (this.data.usage.length > MAX_USAGE_RECORDS) {
      this.data.usage = this.data.usage.slice(-MAX_USAGE_RECORDS);
    }
    this.save();
  }

  usage(): UsageRecord[] {
    return this.data.usage;
  }
}
