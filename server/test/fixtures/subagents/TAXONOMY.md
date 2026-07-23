# Subagent ACP trace taxonomy

Fixture: `subagent-trace.jsonl` — a real `devin acp` session that launched two
`subagent_explore` workers in parallel, one to list `.ts` files and one to
summarize `README.md`.

This document maps the JSON-RPC/ACP events observed in the trace to categories
so the normalized subagent model can be built on observed shapes rather than
inferred tool names.

## Event categories

### 1. Standard ACP `session_update` notifications

These are the regular ACP progress notifications routed through
`session/update`. They are not subagent-specific and are handled today:

- `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` — text
  streaming.
- `plan`, `usage_update`, `config_option_update`, `current_mode_update`,
  `available_commands_update`, `session_info_update` — session metadata.
- `tool_call` and `tool_call_update` — generic tool-call lifecycle (see below).

### 2. Generic tool-call representations

Every tool invocation is announced as a `tool_call` and then updated with a
`tool_call_update`. In the trace these include `run_subagent`, `read_subagent`,
`find_file_by_name`, and `read`.

Generic fields:

- `toolCallId` — unique call id.
- `title`, `kind` — human-readable labels.
- `status` — `pending` | `in_progress` | `completed` | `failed`.
- `rawInput`, `rawOutput` — arguments and result.
- `content` — typed result blocks.

### 3. Cognition-specific extension metadata on tool calls

The Devin CLI annotates tool calls with `_meta["cognition.ai/<name>"]` objects.
These are vendor-specific and are the source of truth for subagent hierarchy.

- `cognition.ai/inferenceToolName` — canonical tool name, e.g. `run_subagent`,
  `read_subagent`, `read`, `find_file_by_name`.
- `cognition.ai/subagent_started` — appears on a `tool_call_update` when a
  subagent actually begins running.
  - `agentId` — the subagent's stable id (also the `toolCallId` of the update).
  - `title` / `task` — what the subagent was asked to do.
  - `profile` — e.g. `"Explore"`.
  - `depth` — nesting depth.
  - `isBackground` — foreground or background.
- `cognition.ai/subagent_completed` — appears on a `tool_call_update` when a
  subagent finishes.
  - `agentId`.
  - `success` / `summary` / `depth`.
- `cognition.ai/subagent_context` — appears on `tool_call` start events for tools
  executed by a subagent.
  - `parentAgentId` — the `agentId` of the subagent that owns this tool.

### 4. Cognition extension notifications

Handled by the `extNotification` ACP client hook (not `session_update`):

- `_cognition.ai/output` — log lines (MCP connects, etc.). Already surfaced as
  agent log.
- `_cognition.ai/thinking_complete` — thinking block metadata. Currently not
  surfaced.
- `_cognition.ai/mcp/serversChanged` — MCP server list changes. Currently not
  surfaced.

### 5. Standard ACP extension notifications (not Cognition-specific)

The trace only contains Cognition extension notifications. No other vendor
extension methods were observed.

### 6. Currently unsupported or ambiguous

- `_cognition.ai/thinking_complete` and `_cognition.ai/mcp/serversChanged` are
  received but ignored after tracing.
- Subagent child tool calls are emitted as `tool_call` start events with
  `subagent_context`, but no matching `tool_call_update` with `rawOutput` was
  observed in the trace. The subagent result is delivered through
  `subagent_completed` and `read_subagent` instead. The implementation should
  therefore not wait for child-tool completions that may never arrive.
- Permission requests on behalf of a subagent were not triggered in this trace
  because the explore profile tools are auto-allowed. The model expects the
  `requestPermission` `toolCall` payload to carry the same
  `cognition.ai/subagent_context` shape.
