// Protocol types for devin-remote — REST + WS + ACP.

export type ThemeName = "dark" | "light" | "system";

export type SessionStatus =
  | "starting"
  | "loading"
  | "idle"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "disconnected"
  | "failed"
  | "closed";

export interface ActiveOperation {
  kind: "prompt" | "cancel" | "attach";
  id: string;
  processGeneration: number;
}

export type SubagentStatus =
  | "starting"
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SubagentDescriptor {
  id: string;
  sessionId: string;
  processGeneration: number;
  parentSubagentId: string | null;
  parentToolCallId: string | null;
  title: string | null;
  prompt: string | null;
  status: SubagentStatus;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  error: string | null;
  profile: string | null;
  depth: number;
  isBackground: boolean;
  toolCallIds: string[];
  pendingPermissions: string[];
}

export interface Settings {
  theme: ThemeName;
  soundComplete: boolean;
  soundNotify: boolean;
  desktopNotify: boolean;
  defaultModel?: string;
  defaultMode?: string;
  worktreeIsolation?: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
}

export interface DevinInfo {
  installed: boolean;
  version: string | null;
  authed: boolean;
  detail: string;
}

export interface ProcessInfo {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  processGeneration: number;
  running: boolean;
}

export interface MetaResponse {
  app: AppInfo;
  devin: DevinInfo;
  workspaces: string[];
  processes: ProcessInfo[];
  settings: Settings;
  primaryCwd: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  alias: string | null;
  branch: string | null;
  worktree: string | null;
  updatedAt: string | null;
}

// ---- ACP session updates --------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | string;

export interface ToolCallContentText {
  type: "content";
  content: { type: string; text?: string };
}

export interface ToolCallContentDiff {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

export interface ToolCallContentTerminal {
  type: "terminal";
  terminalId: string;
}

export type ToolCallContent =
  | ToolCallContentText
  | ToolCallContentDiff
  | ToolCallContentTerminal
  | { type: string; [key: string]: unknown };

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  priority?: string;
}

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: ConfigOptionValue[];
}

export interface SlashCommand {
  name: string;
  description: string;
  input?: unknown;
}

export interface MessageChunkUpdate {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  content: TextContent;
}

export interface ToolCallStartUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  /** Vendor-specific extension metadata, e.g. Cognition subagent context. */
  _meta?: Record<string, unknown>;
}

export interface ToolCallPatchUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  rawOutput?: unknown;
  /** Vendor-specific extension metadata, e.g. Cognition subagent annotations. */
  _meta?: Record<string, unknown>;
}

export interface PlanUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface UsageUpdate {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  _meta?: Record<string, unknown>;
}

export interface ConfigOptionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: ConfigOption[];
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: SlashCommand[];
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  [key: string]: unknown;
}

export type KnownSessionUpdate =
  | MessageChunkUpdate
  | ToolCallStartUpdate
  | ToolCallPatchUpdate
  | PlanUpdate
  | UsageUpdate
  | ConfigOptionUpdate
  | CurrentModeUpdate
  | AvailableCommandsUpdate
  | SessionInfoUpdate;

export type SessionUpdate = KnownSessionUpdate | ({ sessionUpdate: string } & Record<string, unknown>);

// ---- WebSocket events -----------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  /** Set when this permission was requested on behalf of a subagent. */
  subagentId?: string;
  toolCall: { title?: string; kind?: string; rawInput?: unknown; [key: string]: unknown };
  options: PermissionOption[];
}

export type SubagentStartedEvent = {
  type: "subagent_started";
  subagent: SubagentDescriptor;
};

export type SubagentUpdatedEvent = {
  type: "subagent_updated";
  subagentId: string;
  patch: Partial<SubagentDescriptor>;
};

export type SubagentCompletedEvent = {
  type: "subagent_completed";
  subagentId: string;
  result: string | null;
  completedAt: number;
};

export type SubagentFailedEvent = {
  type: "subagent_failed";
  subagentId: string;
  error: string;
  completedAt: number;
  status?: "failed" | "cancelled";
};

export type SubagentCancelledEvent = {
  type: "subagent_cancelled";
  subagentId: string;
  completedAt: number;
};

export type NormalizedSubagentEvent =
  | SubagentStartedEvent
  | SubagentUpdatedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | SubagentCancelledEvent;

export interface PromptDoneResult {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  userMessageId?: string;
}

export interface ServerEventEnvelope {
  type: "event";
  sessionId: string;
  sequence: number;
  processGeneration: number;
  timestamp: number;
  eventType: string;
  payload: unknown;
}

export interface MaterializedSessionState {
  sessionId: string;
  processGeneration: number;
  status: SessionStatus;
  cwd: string;
  title?: string | null;
  alias?: string | null;
  branch?: string | null;
  worktree?: string | null;
  activeOperation?: ActiveOperation | null;
  pendingPermissions: unknown[];
  running: boolean;
  cancellable: boolean;
  latestSequence: number;
}

export interface SnapshotEnvelope {
  type: "snapshot";
  sessionId: string;
  processGeneration: number;
  timestamp: number;
  complete: boolean;
  baseSequence: number | null;
  latestSequence: number;
  state: MaterializedSessionState | null;
  events: ServerEventEnvelope[];
}

export interface WsConfigEvent {
  type: "config";
  app: AppInfo;
  settings: Settings;
}

export interface GenerationChangedEnvelope {
  type: "generation_changed";
  sessionId: string;
  previousGeneration: number;
  processGeneration: number;
  /** True when the server has already established the subscription and sent replay/snapshot. */
  subscriptionEstablished?: boolean;
}

export type WsServerEvent = ServerEventEnvelope | SnapshotEnvelope | GenerationChangedEnvelope | WsConfigEvent;

// ---- REST payloads --------------------------------------------------------

export interface PromptBlockText {
  type: "text";
  text: string;
}

export interface PromptBlockImage {
  type: "image";
  uploadId: string;
  mimeType: string;
}

export interface PromptBlockResourceLink {
  type: "resource_link";
  uri: string;
  name?: string;
}

export type PromptBlock = PromptBlockText | PromptBlockImage | PromptBlockResourceLink;

export interface UploadMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

export interface UsageDay {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

export interface UsageRecord {
  ts: number;
  sessionId: string;
  cwd: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageResponse {
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; turns: number };
  byDay: Record<string, UsageDay>;
  recent: UsageRecord[];
}
