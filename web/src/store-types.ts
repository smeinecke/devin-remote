import type {
  ConfigOption,
  MetaResponse,
  PlanEntry,
  SessionStatus,
  SessionSummary,
  SessionUpdate,
  Settings,
  SlashCommand,
  SubagentDescriptor,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
} from "./types";

export type { Settings, ToolCallContent, SubagentDescriptor };

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "thought";
  text: string;
  attachments: Attachment[];
  streaming: boolean;
  ts: number;
}

export interface ToolCallState {
  id: string;
  title: string;
  kind: string;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  startedAt: number;
  finishedAt: number | null;
  /** If this tool was executed by a subagent, the subagent's id. */
  subagentId?: string | null;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  userMessageId: string;
  status: "running" | "waiting_for_permission" | "completed" | "cancelled" | "failed";
  startedAt: number;
  completedAt?: number;
  activities: AgentActivity[];
  finalMessageId?: string;
  /** Rendered assistant text accumulated for this run (agent + thought chunks). */
  assistantText: string;
  plan: PlanEntry[] | null;
  usage: { used: number; size: number } | null;
}

export type ActivityType =
  | "plan"
  | "file_read"
  | "file_edit"
  | "command"
  | "terminal"
  | "test"
  | "permission"
  | "subagent"
  | "error";

export interface AgentActivity {
  id: string;
  type: ActivityType;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  details?: unknown;
  autoExpand?: boolean;
  /** Optional terminal/diff/file metadata for the inspector. */
  meta?: { path?: string; terminalId?: string; command?: string };
  /** If this activity is a subagent, nested child activities. */
  children?: AgentActivity[];
  /** If this activity represents a subagent, the subagent id. */
  subagentId?: string;
  /** If this activity represents a tool call, the tool call id. */
  toolCallId?: string;
}

export type TimelineItem = { kind: "message" | "tool" | "run"; id: string };

export interface PendingPermission {
  requestId: string;
  /** Set when this permission was requested on behalf of a subagent. */
  subagentId?: string;
  toolCall: { title?: string; kind?: string; rawInput?: unknown; [key: string]: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface TerminalState {
  terminalId: string;
  sessionId: string;
  processGeneration: number;
  status: "running" | "exited" | "killed" | "failed";
  command?: string;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  title: string | null;
  alias: string | null;
  branch: string | null;
  worktree: string | null;
  updatedAt: string | null;
  processGeneration: number;
  status: SessionStatus;
  timeline: TimelineItem[];
  messages: Record<string, ChatMessage>;
  toolCalls: Record<string, ToolCallState>;
  subagents: Record<string, SubagentDescriptor>;
  runs: Record<string, AgentRun>;
  plan: PlanEntry[] | null;
  usage: { used: number; size: number } | null;
  configOptions: ConfigOption[];
  currentModeId: string | null;
  availableCommands: SlashCommand[];
  permissions: PendingPermission[];
  running: boolean;
  synced: boolean;
  unread: boolean;
  openAgentMsg: string | null;
  openThoughtMsg: string | null;
  openUserMsg: string | null;
  /** Highest event sequence applied for the current process generation. */
  lastSequence: number;
  /** Identifier of the active HTTP prompt request, if any. */
  activePromptRequest: { token: string; generation: number } | null;
}

export interface TerminalMeta {
  id: string;
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
  version: number;
  resetSeq: number;
  processGeneration: number;
}

export interface AgentLogEntry {
  ts: number;
  sessionId: string;
  channel: string;
  message: string;
  level: string;
}

export interface UiState {
  sidebarOpen: boolean;
  modal: null | "settings" | "usage" | "palette";
  inspectorTab: "activity" | "changes" | "terminal" | "files" | "logs" | "plan";
  inspectorOpen: boolean;
  activeTerminalBySession: Record<string, string | null>;
  modelPickerOpen: boolean;
  mobileDetail: null | "activity" | "changes" | "terminal";
}

export interface AppState {
  meta: MetaResponse | null;
  settings: Settings;
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
  sessionsLoading: boolean;
  sessionsLoaded: boolean;
  wsConnected: boolean;
  terminals: Record<string, TerminalMeta>;
  agentLog: AgentLogEntry[];
  notice: string | null;
  composerInject: { text: string; seq: number } | null;
  ui: UiState;
}

export type { SessionSummary, SessionUpdate };
