// Bridge between our ACP session store and assistant-ui's ExternalStoreRuntime.
//
// The store stays the source of truth. Timeline items are grouped by "run"
// (one user message → one assistant turn) so that the chat thread shows a
// single assistant bubble per turn containing text, reasoning, and tool-call
// parts, instead of flattening every tool call into a separate message.

import { useMemo, type FC, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReadonlyJSONObject } from "assistant-stream/utils";
import type { Attachment, ChatMessage, SessionState, ToolCallState } from "./state";
import { cancelPrompt, sendPrompt } from "./state";

function safeArgs(raw: unknown): ReadonlyJSONObject {
  if (raw != null && typeof raw === "object") return raw as ReadonlyJSONObject;
  return {};
}

function safeArgsText(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  try {
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];

const userMsgCache = new WeakMap<ChatMessage, ThreadMessageLike>();
const toolPartCache = new WeakMap<ToolCallState, ContentPart>();

function cached<K extends object, V>(cache: WeakMap<K, V>, key: K, build: (k: K) => V): V {
  let v = cache.get(key);
  if (!v) {
    v = build(key);
    cache.set(key, v);
  }
  return v;
}

function userMessage(m: ChatMessage): ThreadMessageLike {
  return {
    id: m.id,
    role: "user",
    createdAt: new Date(m.ts),
    content: [{ type: "text", text: m.text }],
    attachments: m.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      type: "image",
      contentType: a.mime,
      status: { type: "complete" as const },
      content: [{ type: "image" as const, image: a.url }],
    })),
  };
}

function toolCallPart(t: ToolCallState): Extract<ThreadMessageLike["content"], readonly unknown[]>[number] {
  return {
    type: "tool-call",
    toolCallId: t.id,
    toolName: t.kind || t.title || "tool",
    args: safeArgs(t.rawInput),
    argsText: safeArgsText(t.rawInput),
    result: t.rawOutput,
    isError: t.status === "failed",
  };
}

function runMessage(id: string, createdAt: Date, parts: readonly ContentPart[]): ThreadMessageLike {
  return {
    id,
    role: "assistant",
    createdAt,
    content: parts as ThreadMessageLike["content"],
  };
}

export function sessionToMessages(s: SessionState): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];
  let runId = "";
  let runCreatedAt = new Date();
  let runParts: ContentPart[] = [];

  const flushRun = () => {
    if (runParts.length === 0) return;
    out.push(runMessage(runId || `run-${Date.now()}`, runCreatedAt, runParts));
    runParts = [];
    runId = "";
  };

  for (const item of s.timeline) {
    if (item.kind === "message") {
      const m = s.messages[item.id];
      if (!m) continue;
      if (m.role === "user") {
        flushRun();
        out.push(cached(userMsgCache, m, userMessage));
        runId = `${m.id}-run`;
        runCreatedAt = new Date(m.ts);
      } else if (m.role === "thought") {
        if (runParts.length === 0) {
          runId = runId || `run-${m.id}`;
          runCreatedAt = new Date(m.ts);
        }
        runParts.push({ type: "reasoning", text: m.text });
      } else {
        if (runParts.length === 0) {
          runId = runId || `run-${m.id}`;
          runCreatedAt = new Date(m.ts);
        }
        runParts.push({ type: "text", text: m.text });
      }
      continue;
    }

    if (item.kind === "tool") {
      const t = s.toolCalls[item.id];
      if (!t) continue;
      if (runParts.length === 0) {
        runId = runId || `run-${t.id}`;
        runCreatedAt = new Date(t.startedAt);
      }
      runParts.push(cached(toolPartCache, t, toolCallPart));
    }
  }

  flushRun();
  return out;
}

function attachmentImageUrl(a: NonNullable<AppendMessage["attachments"]>[number]): string {
  for (const part of a.content ?? []) {
    if (part.type === "image") return part.image;
  }
  return "";
}

export function SessionRuntime({
  session,
  children,
}: {
  session: SessionState;
  children: ReactNode;
}) {
  const sessionId = session.sessionId;
  const messages = useMemo(() => sessionToMessages(session), [session]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    isRunning: session.running,
    isLoading: !session.synced,
    onNew: async (msg) => {
      const text = msg.content
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const attachments: Attachment[] = (msg.attachments ?? []).map((a) => ({
        id: a.id,
        name: a.name ?? "image",
        mime: a.contentType ?? "image/png",
        url: attachmentImageUrl(a),
      }));
      await sendPrompt(sessionId, text, attachments);
    },
    onCancel: async () => {
      await cancelPrompt(sessionId);
    },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export const SessionRuntimeProvider: FC<{
  session: SessionState;
  children: ReactNode;
}> = SessionRuntime;
