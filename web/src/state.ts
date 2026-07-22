import { useSyncExternalStore } from "react";
import { api } from "./api";
import { subscribeSession, updateCursor, cursors } from "./ws";
import { notifyDesktop, soundComplete, soundNotify } from "./sound";
import type {
  Attachment,
  AppState,
  ChatMessage,
  PendingPermission,
  SessionState,
  SessionSummary,
  SessionUpdate,
  Settings,
  TerminalMeta,
  ToolCallContent,
  ToolCallState,
} from "./store-types";
import { mentionToUri, extractMentions } from "./utils";
import { rebuildRuns } from "./runs";
import type {
  MetaResponse,
  PromptBlock,
  ServerEventEnvelope,
  SnapshotEnvelope,
  WsConfigEvent,
  WsServerEvent,
  MessageChunkUpdate,
  ToolCallStartUpdate,
  ToolCallPatchUpdate,
  PlanUpdate,
  UsageUpdate,
  ConfigOptionUpdate,
  CurrentModeUpdate,
  AvailableCommandsUpdate,
  SessionInfoUpdate,
  PermissionRequestPayload,
} from "./types";

export * from "./store-types";

let state: AppState = {
  meta: null,
  settings: { theme: "light", soundComplete: true, soundNotify: true, desktopNotify: false, worktreeIsolation: true },
  sessions: {},
  activeSessionId: null,
  sessionsLoading: false,
  sessionsLoaded: false,
  wsConnected: false,
  terminals: {},
  agentLog: [],
  notice: null,
  composerInject: null,
  ui: {
    sidebarOpen: false,
    modal: null,
    inspectorTab: "terminal",
    inspectorOpen: false,
    activeTerminalBySession: {},
    modelPickerOpen: false,
    mobileDetail: null,
  },
};

const listeners = new Set<() => void>();
let emitScheduled = false;

function emit(): void {
  if (emitScheduled) return;
  emitScheduled = true;
  requestAnimationFrame(() => {
    emitScheduled = false;
    for (const l of listeners) l();
  });
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState(): AppState {
  return state;
}

export function useStore(): AppState;
export function useStore<T>(selector: (s: AppState) => T): T;
export function useStore<T>(selector?: (s: AppState) => T): T | AppState {
  const getSnapshot = selector ? () => selector(state) : getState;
  return useSyncExternalStore(subscribe, getSnapshot as () => T) as T | AppState;
}

function setState(partial: Partial<AppState>): void {
  state = { ...state, ...partial };
  emit();
}

// Terminal output buffers: key = terminalId (globally unique)
const termBuffers = new Map<string, string>();
const TERM_BUFFER_CAP = 512 * 1024;
const TERM_TOTAL_CAP = 4 * 1024 * 1024;

export function getTerminalOutput(terminalId: string): string {
  return termBuffers.get(terminalId) ?? "";
}

let msgSeq = 0;

function emptySession(summary: SessionSummary): SessionState {
  return {
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    title: summary.title ?? null,
    alias: summary.alias ?? null,
    branch: summary.branch ?? null,
    worktree: summary.worktree ?? null,
    updatedAt: summary.updatedAt ?? null,
    processGeneration: 0,
    status: "idle",
    timeline: [],
    messages: {},
    toolCalls: {},
    runs: {},
    plan: null,
    usage: null,
    configOptions: [],
    currentModeId: null,
    availableCommands: [],
    permissions: [],
    running: false,
    synced: false,
    unread: false,
    openAgentMsg: null,
    openThoughtMsg: null,
    openUserMsg: null,
    lastSequence: 0,
  };
}

export function updateSession(sessionId: string, fn: (draft: SessionState) => void): void {
  const existing = state.sessions[sessionId];
  if (!existing) return;
  const draft = { ...existing };
  fn(draft);
  rebuildRuns(draft);
  setState({ sessions: { ...state.sessions, [sessionId]: draft } });
}

function ensureSession(summary: SessionSummary): void {
  const existing = state.sessions[summary.sessionId];
  if (existing) {
    updateSession(summary.sessionId, (d) => {
      d.cwd = summary.cwd || d.cwd;
      d.title = summary.title ?? d.title;
      d.alias = summary.alias ?? d.alias;
      d.branch = summary.branch ?? d.branch;
      d.worktree = summary.worktree ?? d.worktree;
      d.updatedAt = summary.updatedAt ?? d.updatedAt;
    });
  } else {
    setState({ sessions: { ...state.sessions, [summary.sessionId]: emptySession(summary) } });
  }
}

export async function refreshSessions(): Promise<void> {
  if (state.sessionsLoading) return;
  setState({ sessionsLoading: true });
  try {
    const { sessions } = await api.listSessions();
    for (const s of sessions) ensureSession(s);
    setState({ sessionsLoaded: true });
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to list sessions");
  } finally {
    setState({ sessionsLoading: false });
  }
}

export async function refreshMeta(): Promise<MetaResponse | null> {
  try {
    const meta = await api.meta();
    setState({ meta, settings: meta.settings });
    return meta;
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to load server meta");
    return null;
  }
}

export async function createSession(cwd: string): Promise<void> {
  const dir = cwd.trim() || state.meta?.primaryCwd || "";
  if (!dir) {
    showNotice("no workspace directory — pass a cwd");
    return;
  }
  try {
    const res = await api.createSession(dir, state.settings.worktreeIsolation);
    ensureSession({
      sessionId: res.sessionId,
      cwd: res.cwd,
      title: null,
      alias: null,
      branch: res.branch,
      worktree: res.worktree,
      updatedAt: new Date().toISOString(),
    });
    updateSession(res.sessionId, (d) => {
      d.synced = true;
      d.processGeneration = res.processGeneration;
      d.status = "idle";
    });
    setState({ activeSessionId: res.sessionId, ui: { ...state.ui, sidebarOpen: false } });
    subscribeSession(res.sessionId, res.processGeneration, 0);
    const { defaultModel, defaultMode } = state.settings;
    if (defaultMode) void api.setConfig(res.sessionId, "mode", defaultMode).catch(() => undefined);
    if (defaultModel) void api.setConfig(res.sessionId, "model", defaultModel).catch(() => undefined);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to create session");
  }
}

export async function selectSession(sessionId: string): Promise<void> {
  const s = state.sessions[sessionId];
  if (!s) return;
  setState({ activeSessionId: sessionId, ui: { ...state.ui, sidebarOpen: false } });
  if (s.synced) {
    subscribeSession(sessionId, s.processGeneration, latestSequenceFor(sessionId));
    return;
  }
  // Idempotent attach: does not reload a running session.
  try {
    const open = await api.openSession(sessionId, s.cwd);
    updateSession(sessionId, (d) => {
      d.synced = true;
      d.processGeneration = open.processGeneration;
      d.status = open.status as SessionState["status"];
      d.branch = open.branch ?? d.branch;
      d.worktree = open.worktree ?? d.worktree;
    });
    subscribeSession(sessionId, open.processGeneration, 0);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to open session");
  }
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  updateSession(sessionId, (d) => {
    d.alias = title || null;
  });
  try {
    await api.rename(sessionId, title);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "rename failed");
  }
}

// Reducer for session updates
function applySessionUpdate(sessionId: string, update: SessionUpdate): void {
  ensureSession({
    sessionId,
    cwd: state.sessions[sessionId] ? "" : state.meta?.primaryCwd ?? "",
    title: null,
    alias: null,
    branch: null,
    worktree: null,
    updatedAt: null,
  });
  updateSession(sessionId, (d) => {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const u = update as MessageChunkUpdate;
        const role =
          u.sessionUpdate === "user_message_chunk"
            ? "user"
            : u.sessionUpdate === "agent_thought_chunk"
              ? "thought"
              : "agent";
        closeOpenMessages(d, role);
        appendChunk(d, role, u.content?.text ?? "");
        if (role !== "user") d.running = true;
        break;
      }
      case "tool_call": {
        const u = update as ToolCallStartUpdate;
        closeOpenMessages(d);
        d.running = true;
        const existing = d.toolCalls[u.toolCallId];
        const tc: ToolCallState = {
          id: u.toolCallId,
          title: u.title ?? existing?.title ?? "tool call",
          kind: u.kind ?? existing?.kind ?? "other",
          status: u.status ?? "pending",
          content: [...(existing?.content ?? []), ...normalizeToolContent(u.content)],
          locations: u.locations ?? existing?.locations,
          rawInput: u.rawInput ?? existing?.rawInput,
          rawOutput: existing?.rawOutput,
          startedAt: existing?.startedAt ?? Date.now(),
          finishedAt: existing?.finishedAt ?? null,
        };
        d.toolCalls = { ...d.toolCalls, [tc.id]: tc };
        if (!existing) d.timeline = [...d.timeline, { kind: "tool", id: tc.id }];
        registerTerminalsFromContent(sessionId, processGeneration, tc.content);
        break;
      }
      case "tool_call_update": {
        const u = update as ToolCallPatchUpdate;
        const existing = d.toolCalls[u.toolCallId];
        if (!existing) {
          const tc: ToolCallState = {
            id: u.toolCallId,
            title: "tool call",
            kind: "other",
            status: u.status ?? "in_progress",
            content: normalizeToolContent(u.content),
            rawOutput: u.rawOutput,
            startedAt: Date.now(),
            finishedAt: null,
          };
          d.toolCalls = { ...d.toolCalls, [tc.id]: tc };
          d.timeline = [...d.timeline, { kind: "tool", id: tc.id }];
          registerTerminalsFromContent(sessionId, processGeneration, tc.content);
          break;
        }
        const merged: ToolCallState = {
          ...existing,
          status: u.status ?? existing.status,
          content: u.content ? [...existing.content, ...u.content] : existing.content,
          rawOutput: u.rawOutput ?? existing.rawOutput,
          finishedAt:
            (u.status === "completed" || u.status === "failed") && existing.finishedAt == null
              ? Date.now()
              : existing.finishedAt,
        };
        d.toolCalls = { ...d.toolCalls, [merged.id]: merged };
        if (u.content) registerTerminalsFromContent(sessionId, processGeneration, u.content);
        break;
      }
      case "plan": {
        const u = update as PlanUpdate;
        closeOpenMessages(d);
        d.plan = u.entries ?? [];
        d.running = true;
        break;
      }
      case "usage_update": {
        const u = update as UsageUpdate;
        d.usage = { used: Number(u.used ?? 0), size: Number(u.size ?? 0) };
        break;
      }
      case "config_option_update": {
        const u = update as ConfigOptionUpdate;
        d.configOptions = u.configOptions ?? [];
        break;
      }
      case "current_mode_update": {
        const u = update as CurrentModeUpdate;
        d.currentModeId = u.currentModeId;
        break;
      }
      case "available_commands_update": {
        const u = update as AvailableCommandsUpdate;
        d.availableCommands = u.availableCommands ?? [];
        break;
      }
      case "session_info_update": {
        const u = update as SessionInfoUpdate;
        if (typeof u.title === "string" && u.title) d.title = u.title;
        break;
      }
    }
    d.updatedAt = new Date().toISOString();
  });
}

function appendChunk(d: SessionState, role: "user" | "agent" | "thought", text: string): void {
  const openKey = role === "user" ? "openUserMsg" : role === "agent" ? "openAgentMsg" : "openThoughtMsg";
  const openId = d[openKey];
  if (openId && d.messages[openId]) {
    const msg = d.messages[openId];
    d.messages = { ...d.messages, [openId]: { ...msg, text: msg.text + text } };
    return;
  }
  const id = `m${++msgSeq}`;
  const msg: ChatMessage = { id, role, text, attachments: [], streaming: true, ts: Date.now() };
  d.messages = { ...d.messages, [id]: msg };
  d.timeline = [...d.timeline, { kind: "message", id }];
  d[openKey] = id;
}

function closeOpenMessages(d: SessionState, except?: "user" | "agent" | "thought"): void {
  const keys: Array<"openUserMsg" | "openAgentMsg" | "openThoughtMsg"> = [
    "openUserMsg",
    "openAgentMsg",
    "openThoughtMsg",
  ];
  for (const k of keys) {
    if (except && k === `open${except[0].toUpperCase()}${except.slice(1)}Msg`) continue;
    const id = d[k];
    if (id && d.messages[id]?.streaming) {
      d.messages = { ...d.messages, [id]: { ...d.messages[id], streaming: false } };
    }
    d[k] = null;
  }
}

function normalizeToolContent(items: ToolCallContent[] | undefined): ToolCallContent[] {
  return Array.isArray(items) ? items : [];
}

function registerTerminalsFromContent(sessionId: string, processGeneration: number, content: ToolCallContent[]): void {
  const generation = state.sessions[sessionId]?.processGeneration ?? processGeneration;
  for (const item of content) {
    if (item.type === "terminal" && typeof (item as { terminalId?: unknown }).terminalId === "string") {
      ensureTerminalMeta((item as { terminalId: string }).terminalId, sessionId, generation);
    }
  }
}

function ensureTerminalMeta(terminalId: string, sessionId: string, processGeneration: number): void {
  const existing = state.terminals[terminalId];
  if (existing) {
    if (existing.processGeneration !== processGeneration) {
      setState({
        terminals: {
          ...state.terminals,
          [terminalId]: { ...existing, processGeneration },
        },
      });
    }
    return;
  }
  setState({
    terminals: {
      ...state.terminals,
      [terminalId]: { id: terminalId, sessionId, exitCode: null, signal: null, version: 0, resetSeq: 0, processGeneration },
    },
  });
}

function appendTerminalOutput(terminalId: string, sessionId: string, processGeneration: number, data: string): void {
  ensureTerminalMeta(terminalId, sessionId, processGeneration);
  let buf = (termBuffers.get(terminalId) ?? "") + data;
  const meta = state.terminals[terminalId];
  let resetSeq = meta.resetSeq;
  if (buf.length > TERM_BUFFER_CAP) {
    buf = buf.slice(-TERM_BUFFER_CAP / 2);
    resetSeq += 1;
  }
  termBuffers.set(terminalId, buf);
  pruneTerminalBuffers(terminalId);
  setState({
    terminals: {
      ...state.terminals,
      [terminalId]: { ...meta, version: meta.version + 1, resetSeq, processGeneration },
    },
  });
}

function pruneTerminalBuffers(currentId: string): void {
  let total = 0;
  for (const buf of termBuffers.values()) total += buf.length;
  if (total <= TERM_TOTAL_CAP) return;
  const pruned: string[] = [];
  for (const [id, buf] of termBuffers) {
    if (id === currentId) continue;
    const meta = state.terminals[id];
    if (meta && meta.exitCode === null && meta.signal === null) continue;
    termBuffers.delete(id);
    pruned.push(id);
    total -= buf.length;
    if (total <= TERM_TOTAL_CAP) break;
  }
  if (pruned.length === 0) return;
  const terminals = { ...state.terminals };
  for (const id of pruned) {
    const meta = terminals[id];
    if (meta) terminals[id] = { ...meta, version: meta.version + 1, resetSeq: meta.resetSeq + 1 };
  }
  setState({ terminals });
}

function latestSequenceFor(sessionId: string): number {
  return cursors.get(sessionId)?.after ?? 0;
}

// Prompting
export interface OutgoingAttachment extends Attachment {
  mime: string;
}

export async function sendPrompt(sessionId: string, text: string, attachments: Attachment[]): Promise<void> {
  const s = state.sessions[sessionId];
  if (!s) return;
  const blocks: PromptBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text });
  for (const a of attachments) {
    blocks.push({ type: "image", uploadId: a.id, mimeType: a.mime });
  }
  for (const m of extractMentions(text)) {
    blocks.push({ type: "resource_link", uri: mentionToUri(m, s.cwd), name: m });
  }
  if (blocks.length === 0) return;

  const id = `m${++msgSeq}`;
  const msg: ChatMessage = { id, role: "user", text, attachments, streaming: false, ts: Date.now() };
  updateSession(sessionId, (d) => {
    closeOpenMessages(d);
    d.messages = { ...d.messages, [id]: msg };
    d.timeline = [...d.timeline, { kind: "message", id }];
    d.running = true;
  });

  try {
    await api.prompt(sessionId, blocks);
  } catch (err) {
    const eid = `m${++msgSeq}`;
    updateSession(sessionId, (d) => {
      closeOpenMessages(d);
      d.messages = {
        ...d.messages,
        [eid]: {
          id: eid,
          role: "agent",
          text: `**Error:** ${err instanceof Error ? err.message : "prompt failed"}`,
          attachments: [],
          streaming: false,
          ts: Date.now(),
        },
      };
      d.timeline = [...d.timeline, { kind: "message", id: eid }];
      d.running = false;
    });
  }
}

export async function cancelPrompt(sessionId: string): Promise<void> {
  const s = state.sessions[sessionId];
  if (!s) return;
  try {
    await api.cancel(sessionId);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "cancel failed");
    updateSession(sessionId, (d) => {
      d.running = false;
    });
  }
}

export async function setSessionConfig(sessionId: string, configId: "mode" | "model", value: string): Promise<void> {
  const s = state.sessions[sessionId];
  if (!s) return;
  const prevOptions = s.configOptions;
  const prevMode = s.currentModeId;
  updateSession(sessionId, (d) => {
    d.configOptions = d.configOptions.map((opt) =>
      opt.id === configId || opt.category === configId ? { ...opt, currentValue: value } : opt,
    );
    if (configId === "mode") d.currentModeId = value;
  });
  try {
    await api.setConfig(sessionId, configId, value);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to set config");
    updateSession(sessionId, (d) => {
      d.configOptions = prevOptions;
      d.currentModeId = prevMode;
    });
  }
}

// Permissions
export async function resolvePermission(requestId: string, optionId: string | null): Promise<void> {
  try {
    await api.resolvePermission(requestId, optionId);
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "permission resolution failed");
  }
  removePermission(requestId);
}

function removePermission(requestId: string): void {
  for (const sid of Object.keys(state.sessions)) {
    const s = state.sessions[sid];
    if (s.permissions.some((p) => p.requestId === requestId)) {
      updateSession(sid, (d) => {
        d.permissions = d.permissions.filter((p) => p.requestId !== requestId);
      });
    }
  }
}

// UI helpers
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export function showNotice(text: string): void {
  setState({ notice: text });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setState({ notice: null }), 5000);
}

export function hideNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  setState({ notice: null });
}

export function setUi(patch: Partial<AppState["ui"]>): void {
  setState({ ui: { ...state.ui, ...patch } });
}

export function setWsConnected(connected: boolean): void {
  if (state.wsConnected !== connected) setState({ wsConnected: connected });
}

export function injectIntoComposer(text: string): void {
  setState({ composerInject: { text, seq: (state.composerInject?.seq ?? 0) + 1 } });
}

export function pushAgentLog(entry: AppState["agentLog"][number]): void {
  const log = [...state.agentLog, entry];
  if (log.length > 500) log.splice(0, log.length - 500);
  setState({ agentLog: log });
}

export function clearAgentLog(): void {
  setState({ agentLog: [] });
}

// Settings
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const prev = state.settings;
  setState({ settings: { ...prev, ...patch } });
  try {
    const next = await api.putSettings(patch);
    setState({ settings: next });
  } catch (err) {
    showNotice(err instanceof Error ? err.message : "failed to save settings");
    setState({ settings: prev });
  }
}

// WS dispatch
export function dispatchEvent(ev: WsServerEvent): void {
  if (ev.type === "config") {
    const c = ev as WsConfigEvent;
    setState({ settings: c.settings });
    return;
  }

  if (ev.type === "snapshot") {
    const s = ev as SnapshotEnvelope;
    // Only treat the snapshot as a full replacement when the server explicitly
    // says it is complete and provides a materialized state. Otherwise merge
    // events into the existing view and preserve already-applied sequences.
    const replacing = s.complete && s.state != null;
    const snapshotState = (s.state ?? {}) as Partial<SessionState>;
    ensureSession({
      sessionId: s.sessionId,
      cwd: snapshotState.cwd ?? state.meta?.primaryCwd ?? "",
      title: snapshotState.title ?? null,
      alias: snapshotState.alias ?? null,
      branch: snapshotState.branch ?? null,
      worktree: snapshotState.worktree ?? null,
      updatedAt: null,
    });
    updateSession(s.sessionId, (d) => {
      d.processGeneration = s.processGeneration;
      if (replacing) {
        d.lastSequence = 0;
        d.timeline = [];
        d.messages = {};
        d.toolCalls = {};
        d.runs = {};
        d.plan = null;
        d.usage = null;
        d.running = false;
        d.permissions = [];
      }
      if (snapshotState.status) d.status = snapshotState.status as SessionState["status"];
      if (snapshotState.pendingPermissions) d.permissions = snapshotState.pendingPermissions as PendingPermission[];
      d.synced = true;
    });
    for (const e of s.events) applyEventEnvelope(e as ServerEventEnvelope);
    return;
  }

  if (ev.type === "event") {
    applyEventEnvelope(ev as ServerEventEnvelope);
  }
}

function applyEventEnvelope(ev: ServerEventEnvelope): void {
  const { sessionId, processGeneration, eventType, payload } = ev;
  if (eventType === "generation_changed") {
    const p = payload as { previousGeneration: number; processGeneration: number };
    ensureSession({
      sessionId,
      cwd: state.sessions[sessionId] ? "" : state.meta?.primaryCwd ?? "",
      title: null,
      alias: null,
      branch: null,
      worktree: null,
      updatedAt: null,
    });
    updateSession(sessionId, (d) => {
      d.processGeneration = p.processGeneration;
      d.lastSequence = 0;
      d.running = false;
      d.permissions = [];
      d.openAgentMsg = null;
      d.openThoughtMsg = null;
      d.openUserMsg = null;
      d.status = "loading";
    });
    // Drop terminal metadata and buffers belonging to the replaced generation.
    const nextTerminals: Record<string, TerminalMeta> = {};
    for (const [id, meta] of Object.entries(state.terminals)) {
      if (meta.sessionId === sessionId && meta.processGeneration === p.previousGeneration) {
        termBuffers.delete(id);
      } else {
        nextTerminals[id] = meta;
      }
    }
    setState({ terminals: nextTerminals });
    subscribeSession(sessionId, p.processGeneration, 0);
    return;
  }
  const session = state.sessions[sessionId];
  if (session && session.processGeneration !== processGeneration) {
    // Ignore stale events from a replaced process.
    return;
  }
  if (session && ev.sequence <= session.lastSequence) {
    // Already applied.
    return;
  }

  switch (eventType) {
    case "session_update": {
      applySessionUpdate(sessionId, payload as SessionUpdate);
      updateSession(sessionId, (d) => {
        d.processGeneration = processGeneration;
      });
      break;
    }
    case "state_change": {
      const p = payload as { previous: string; next: string };
      updateSession(sessionId, (d) => {
        d.status = p.next as SessionState["status"];
        d.processGeneration = processGeneration;
      });
      break;
    }
    case "permission_request": {
      const p = payload as PermissionRequestPayload;
      ensureSession({
        sessionId,
        cwd: state.sessions[sessionId] ? "" : state.meta?.primaryCwd ?? "",
        title: null,
        alias: null,
        branch: null,
        worktree: null,
        updatedAt: null,
      });
      const perm: PendingPermission = {
        requestId: p.requestId,
        toolCall: p.toolCall,
        options: p.options,
      };
      updateSession(sessionId, (d) => {
        d.permissions = [...d.permissions, perm];
        d.status = "waiting_for_permission";
      });
      if (state.settings.soundNotify) soundNotify();
      if (document.hidden && state.settings.desktopNotify) {
        notifyDesktop("Devin needs permission", String(p.toolCall?.title ?? "a tool call"));
      }
      break;
    }
    case "permission_resolved": {
      const p = payload as { requestId: string };
      removePermission(p.requestId);
      break;
    }
    case "terminal_output": {
      const p = payload as { terminalId: string; data: string };
      appendTerminalOutput(p.terminalId, sessionId, processGeneration, p.data);
      break;
    }
    case "terminal_exit": {
      const p = payload as { terminalId: string; exitCode: number | null; signal: string | null };
      const meta = state.terminals[p.terminalId];
      if (meta && meta.sessionId === sessionId && meta.processGeneration === processGeneration) {
        setState({
          terminals: {
            ...state.terminals,
            [p.terminalId]: { ...meta, exitCode: p.exitCode, signal: p.signal },
          },
        });
      }
      break;
    }
    case "agent_log": {
      const p = payload as { channel: string; message: string; level: string };
      pushAgentLog({ ts: Date.now(), sessionId, channel: p.channel, message: p.message, level: p.level });
      break;
    }
    case "process_status": {
      const p = payload as { status: string; code: number | null };
      updateSession(sessionId, (d) => {
        d.status = "disconnected";
        d.running = false;
      });
      if (p.status === "exited") showNotice(`session process exited (${p.code ?? "?"}) — ${sessionId}`);
      break;
    }
    case "prompt_done": {
      const p = payload as { result: { stopReason?: string; usage?: unknown } };
      updateSession(sessionId, (d) => {
        closeOpenMessages(d);
        d.running = false;
        d.status = "idle";
      });
      if (state.settings.soundComplete) soundComplete();
      if (document.hidden && state.settings.desktopNotify) {
        notifyDesktop("Devin finished a turn", `stop reason: ${p.result?.stopReason ?? "end_turn"}`);
      }
      setTimeout(() => void refreshSessions(), 1500);
      break;
    }
  }

  // Update cursor and last-sequence tracker so reconnect resumes from here.
  if (sessionId && processGeneration) {
    const cur = getCursor(sessionId);
    if (cur && cur.processGeneration === processGeneration) {
      updateCursor(sessionId, processGeneration, Math.max(cur.after, ev.sequence));
    } else {
      updateCursor(sessionId, processGeneration, ev.sequence);
    }
    const current = state.sessions[sessionId];
    if (current && current.processGeneration === processGeneration && ev.sequence > current.lastSequence) {
      setState({
        sessions: { ...state.sessions, [sessionId]: { ...current, lastSequence: ev.sequence } },
      });
    }
  }

  // Background unread activity.
  if (sessionId && sessionId !== state.activeSessionId && eventType !== "state_change") {
    updateSession(sessionId, (d) => {
      d.unread = true;
    });
  }
}

function getCursor(sessionId: string): { processGeneration: number; after: number } | undefined {
  return cursors.get(sessionId);
}
